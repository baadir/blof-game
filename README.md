# blof-game

Basit blöf oyunu için **multiplayer MVP**.

## Çalıştırma
```bash
npm install
npm start
```

Sunucu: http://localhost:3000

## MVP Kuralları (özet)
- 52’lik deste, joker yok.
- 2–5 oyuncu, kişi başı 5 kart.
- Turda 1–3 kart kapalı oynanır, sadece **rank** beyan edilir.
- Beyan **aynı veya daha yüksek** rank olmalı.
- İtiraz ("Blöf!") gelirse: doğruysa challenger tüm ortayı alır, yanlışsa beyan eden alır.
- İtiraz gelmezse sıra bir sonraki oyuncuya geçer.
- Son kartını oynayıp başarılı şekilde challenge edilmezse kazanır.

## Notlar
- Şu an **lobi + core turn flow** var (UI basit).
- Eski Firebase prototipi: `legacy-firebase.html`
