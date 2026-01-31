const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

const MAX_PLAYERS = 5;
const rooms = new Map();

function makeId(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function safeSend(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  room.clients.forEach((ws) => safeSend(ws, msg));
}

function roomState(roomId, room) {
  return {
    type: "room_state",
    roomId,
    players: Array.from(room.players.values()),
    maxPlayers: MAX_PLAYERS,
  };
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
        players: new Map(),
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
      if (room.players.size >= MAX_PLAYERS) {
        return safeSend(ws, { type: "error", message: "Room is full" });
      }
      joinRoom(ws, roomId, name);
      return;
    }

    if (msg.type === "leave_room") {
      leaveRoom(ws);
      return;
    }
  });

  ws.on("close", () => {
    leaveRoom(ws);
  });
});

function joinRoom(ws, roomId, name) {
  leaveRoom(ws);
  const room = rooms.get(roomId);
  ws.roomId = roomId;
  room.clients.add(ws);
  room.players.set(ws.clientId, { id: ws.clientId, name });
  safeSend(ws, { type: "joined", roomId, clientId: ws.clientId });
  broadcast(room, roomState(roomId, room));
}

function leaveRoom(ws) {
  if (!ws.roomId) return;
  const roomId = ws.roomId;
  const room = rooms.get(roomId);
  if (!room) return;
  room.clients.delete(ws);
  room.players.delete(ws.clientId);
  ws.roomId = null;
  if (room.players.size === 0) {
    rooms.delete(roomId);
  } else {
    broadcast(room, roomState(roomId, room));
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`blof-game server running on http://localhost:${PORT}`);
});
