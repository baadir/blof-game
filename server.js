const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

const MAX_PLAYERS = 5;
const HAND_SIZE = 5;
const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const SUITS = ["♠","♥","♦","♣"];

const rooms = new Map();

function makeId(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildDeck() {
  let idCounter = 0;
  const deck = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push({ id: `${rank}${suit}-${idCounter++}`, rank, suit });
    }
  }
  return shuffle(deck);
}

function safeSend(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  room.clients.forEach((ws) => safeSend(ws, msg));
}

function publicState(roomId, room) {
  return {
    type: "room_state",
    roomId,
    status: room.status,
    players: room.players.map((p) => ({ id: p.id, name: p.name })),
    maxPlayers: MAX_PLAYERS,
    hostId: room.hostId,
    turnPlayerId: room.turnPlayerId,
    lastClaimRank: room.lastClaimRank,
    pileCount: room.pile.length,
    awaitingChallenge: room.awaitingChallenge,
    lastPlayBy: room.lastPlay?.playerId || null,
    accepts: Array.from(room.accepts || []),
    winnerId: room.winnerId || null,
  };
}

function sendHands(room) {
  room.clients.forEach((ws) => {
    const hand = room.hands.get(ws.clientId) || [];
    safeSend(ws, { type: "hand", hand });
  });
}

function nextPlayer(room, currentId) {
  const idx = room.players.findIndex((p) => p.id === currentId);
  if (idx === -1) return null;
  const nextIdx = (idx + 1) % room.players.length;
  return room.players[nextIdx].id;
}

app.use(express.static(path.join(__dirname, "public")));

wss.on("connection", (ws) => {
  const clientId = makeId(8);
  ws.clientId = clientId;
  ws.roomId = null;

  safeSend(ws, { type: "hello", clientId });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return safeSend(ws, { type: "error", message: "Invalid JSON" });
    }

    if (msg.type === "create_room") {
      const name = (msg.name || "Player").slice(0, 20);
      let roomId = makeId(5);
      while (rooms.has(roomId)) roomId = makeId(5);
      const room = {
        clients: new Set(),
        players: [],
        hands: new Map(),
        deck: [],
        pile: [],
        status: "waiting",
        hostId: clientId,
        turnPlayerId: null,
        lastClaimRank: null,
        awaitingChallenge: false,
        lastPlay: null,
        accepts: new Set(),
        winnerId: null,
      };
      rooms.set(roomId, room);
      joinRoom(ws, roomId, name);
      return;
    }

    if (msg.type === "join_room") {
      const roomId = String(msg.roomId || "").toUpperCase();
      const name = (msg.name || "Player").slice(0, 20);
      if (!rooms.has(roomId)) {
        return safeSend(ws, { type: "error", message: "Room not found" });
      }
      const room = rooms.get(roomId);
      if (room.players.length >= MAX_PLAYERS) {
        return safeSend(ws, { type: "error", message: "Room is full" });
      }
      joinRoom(ws, roomId, name);
      return;
    }

    if (msg.type === "leave_room") {
      leaveRoom(ws);
      return;
    }

    if (msg.type === "start_game") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.clientId) return;
      if (room.players.length < 2) return;
      startGame(roomIdFrom(ws), room);
      return;
    }

    if (msg.type === "play") {
      const room = rooms.get(ws.roomId);
      if (!room || room.status !== "playing") return;
      if (room.turnPlayerId !== ws.clientId) return;
      if (room.awaitingChallenge) return;

      const cards = Array.isArray(msg.cards) ? msg.cards : [];
      if (cards.length < 1 || cards.length > 3) {
        return safeSend(ws, { type: "error", message: "1-3 kart seçmelisin" });
      }
      const claimRank = String(msg.claimRank || "");
      if (!RANKS.includes(claimRank)) {
        return safeSend(ws, { type: "error", message: "Geçersiz beyan" });
      }
      if (room.lastClaimRank) {
        const prevIdx = RANKS.indexOf(room.lastClaimRank);
        const nextIdx = RANKS.indexOf(claimRank);
        if (nextIdx < prevIdx) {
          return safeSend(ws, { type: "error", message: "Beyan en az önceki kadar yüksek olmalı" });
        }
      }

      const hand = room.hands.get(ws.clientId) || [];
      const cardObjs = cards.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
      if (cardObjs.length !== cards.length) {
        return safeSend(ws, { type: "error", message: "Kart doğrulanamadı" });
      }

      // remove from hand
      const remaining = hand.filter((c) => !cards.includes(c.id));
      room.hands.set(ws.clientId, remaining);
      // add to pile
      room.pile.push(...cardObjs);
      room.lastClaimRank = claimRank;
      room.lastPlay = { playerId: ws.clientId, cards: cardObjs, claimRank };
      room.awaitingChallenge = true;
      room.accepts = new Set([ws.clientId]);

      broadcast(room, publicState(roomIdFrom(ws), room));
      sendHands(room);
      return;
    }

    if (msg.type === "accept") {
      const room = rooms.get(ws.roomId);
      if (!room || !room.awaitingChallenge || !room.lastPlay) return;
      if (ws.clientId === room.lastPlay.playerId) return;
      room.accepts.add(ws.clientId);
      const allAccepted = room.players.every((p) => room.accepts.has(p.id));
      if (allAccepted) {
        const claimantId = room.lastPlay.playerId;
        // no challenge
        room.awaitingChallenge = false;
        room.lastPlay = null;
        room.accepts = new Set();
        room.turnPlayerId = nextPlayer(room, claimantId);
        // win check: claimant wins if they have no cards and weren't successfully challenged
        ensureWinOnNoChallenge(room, claimantId);
      }
      broadcast(room, publicState(roomIdFrom(ws), room));
      sendHands(room);
      return;
    }

    if (msg.type === "challenge") {
      const room = rooms.get(ws.roomId);
      if (!room || !room.awaitingChallenge || !room.lastPlay) return;
      if (ws.clientId === room.lastPlay.playerId) return;

      const claimantId = room.lastPlay.playerId;
      const challengedCards = room.lastPlay.cards;
      const truthful = challengedCards.every((c) => c.rank === room.lastPlay.claimRank);

      const loserId = truthful ? ws.clientId : claimantId;
      const winnerId = truthful ? claimantId : ws.clientId;

      const loserHand = room.hands.get(loserId) || [];
      room.hands.set(loserId, loserHand.concat(room.pile));
      room.pile = [];

      room.awaitingChallenge = false;
      room.lastPlay = null;
      room.accepts = new Set();
      room.lastClaimRank = null;

      // win check (claimant only wins if not successfully challenged)
      maybeWin(room, claimantId, truthful);

      if (!room.winnerId) {
        room.turnPlayerId = nextPlayer(room, claimantId);
      }

      broadcast(room, {
        type: "challenge_result",
        truthful,
        claimantId,
        challengerId: ws.clientId,
        loserId,
        winnerId,
      });
      broadcast(room, publicState(roomIdFrom(ws), room));
      sendHands(room);
      return;
    }
  });

  ws.on("close", () => {
    leaveRoom(ws);
  });
});

function roomIdFrom(ws) {
  return ws.roomId;
}

function ensureWinOnNoChallenge(room, claimantId) {
  const hand = room.hands.get(claimantId) || [];
  if (hand.length === 0) {
    room.winnerId = claimantId;
    room.status = "ended";
  }
}

function maybeWin(room, claimantId, truthful) {
  if (!truthful) return; // successful challenge means claimant lied
  ensureWinOnNoChallenge(room, claimantId);
}

function startGame(roomId, room) {
  room.status = "playing";
  room.deck = buildDeck();
  room.pile = [];
  room.lastClaimRank = null;
  room.awaitingChallenge = false;
  room.lastPlay = null;
  room.accepts = new Set();
  room.winnerId = null;

  // deal
  room.players.forEach((p) => {
    const hand = room.deck.splice(0, HAND_SIZE);
    room.hands.set(p.id, hand);
  });

  room.turnPlayerId = room.players[0]?.id || null;
  broadcast(room, publicState(roomId, room));
  sendHands(room);
}

function joinRoom(ws, roomId, name) {
  leaveRoom(ws);
  const room = rooms.get(roomId);
  ws.roomId = roomId;
  room.clients.add(ws);
  room.players.push({ id: ws.clientId, name });
  safeSend(ws, { type: "joined", roomId, clientId: ws.clientId, hostId: room.hostId });
  broadcast(room, publicState(roomId, room));
  sendHands(room);
}

function leaveRoom(ws) {
  if (!ws.roomId) return;
  const roomId = ws.roomId;
  const room = rooms.get(roomId);
  if (!room) return;
  room.clients.delete(ws);
  room.players = room.players.filter((p) => p.id !== ws.clientId);
  room.hands.delete(ws.clientId);
  ws.roomId = null;

  if (room.players.length === 0) {
    rooms.delete(roomId);
  } else {
    if (room.hostId === ws.clientId) {
      room.hostId = room.players[0]?.id || null;
    }
    if (room.turnPlayerId === ws.clientId) {
      room.turnPlayerId = room.players[0]?.id || null;
    }
    broadcast(room, publicState(roomId, room));
    sendHands(room);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`blof-game server running on http://localhost:${PORT}`);
});
