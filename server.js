const express = require("express");
const cors = require("cors");
const path = require("path");
const basicAuth = require("basic-auth");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
app.use(express.json());

/* 🔒 BLOKADA PO DACIE */
app.use((req, res, next) => {
  const expires = process.env.DEMO_EXPIRES;
  if (!expires) return next();

  const now = new Date();
  const end = new Date(expires + "T23:59:59");

  if (now > end) {
    return res.status(403).json({
      error: "Okres testowy zakończony."
    });
  }

  next();
});

/* 🔐 HASŁO */
app.use((req, res, next) => {
  const user = basicAuth(req);

  if (
    !user ||
    user.name !== process.env.DEMO_USER ||
    user.pass !== process.env.DEMO_PASS
  ) {
    res.set("WWW-Authenticate", 'Basic realm="Traseo Demo"');
    return res.status(401).send("Authentication required.");
  }

  next();
});

/* 🚦 RATE LIMIT */
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60
}));

/* 🌐 FRONTEND */
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* 🚀 PORT */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});