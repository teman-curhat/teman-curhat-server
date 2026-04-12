const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);

const LISTENER_SECRET = process.env.LISTENER_SECRET || "listener123";
const MODERATOR_SECRET = process.env.MODERATOR_SECRET || "mod999";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// In-memory state only — no DB, no persistence
let listeners = {};   // socketId -> { alias, busy, socketId }
let talkers = {};     // socketId -> { socketId, waitingForNotif }
let sessions = {};    // sessionId -> { talkerId, listenerId, messages[], startTime }
let waitingQueue = []; // talker socketIds waiting for a listener
let moderators = new Set();

function getAvailableListener() {
  return Object.values(listeners).find((l) => !l.busy);
}

function broadcastModeratorUpdate() {
  const state = {
    listeners: Object.values(listeners),
    talkers: Object.values(talkers),
    sessions: Object.values(sessions).map((s) => ({
      sessionId: s.sessionId,
      listenerAlias: listeners[s.listenerId]?.alias || "?",
      messageCount: s.messages.length,
      startTime: s.startTime,
    })),
    queue: waitingQueue.length,
  };
  moderators.forEach((modId) => io.to(modId).emit("mod:update", state));
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ─── LISTENER JOIN ───────────────────────────────────────────────────
  socket.on("listener:join", ({ secret, alias }) => {
    if (secret !== LISTENER_SECRET) {
      socket.emit("error", { message: "Kode rahasia salah." });
      return;
    }
    listeners[socket.id] = { socketId: socket.id, alias: alias || "Listener", busy: false };
    socket.emit("listener:joined", { alias: listeners[socket.id].alias });
    broadcastModeratorUpdate();

    // If there's a waiting talker, notify listener immediately
    if (waitingQueue.length > 0) {
      socket.emit("listener:talker_waiting");
    }
  });

  // Listener accepts a talker from the queue
  socket.on("listener:accept", () => {
    if (!listeners[socket.id] || listeners[socket.id].busy) return;
    const talkerId = waitingQueue.shift();
    if (!talkerId || !talkers[talkerId]) return;

    const sessionId = uuidv4();
    listeners[socket.id].busy = true;
    sessions[sessionId] = {
      sessionId,
      talkerId,
      listenerId: socket.id,
      messages: [],
      startTime: new Date().toISOString(),
    };

    io.to(talkerId).emit("session:start", { sessionId });
    socket.emit("session:start", { sessionId, listenerMode: true });
    broadcastModeratorUpdate();
  });

  // Listener rejects / skips
  socket.on("listener:reject", () => {
    const talkerId = waitingQueue[0];
    if (talkerId) {
      // Put back, try next available listener
      io.to(talkerId).emit("session:no_listener");
    }
  });

  // ─── TALKER JOIN ─────────────────────────────────────────────────────
  socket.on("talker:join", () => {
    talkers[socket.id] = { socketId: socket.id, waitingForNotif: false };
    waitingQueue.push(socket.id);
    const available = getAvailableListener();
    if (available) {
      io.to(available.socketId).emit("listener:talker_waiting");
      socket.emit("talker:waiting");
    } else {
      talkers[socket.id].waitingForNotif = true;
      socket.emit("talker:queued");
    }
    broadcastModeratorUpdate();
  });

  // ─── CHAT MESSAGE ─────────────────────────────────────────────────────
  socket.on("chat:message", ({ sessionId, text }) => {
    const session = sessions[sessionId];
    if (!session) return;
    if (session.talkerId !== socket.id && session.listenerId !== socket.id) return;

    const role = session.talkerId === socket.id ? "talker" : "listener";
    const msg = { role, text, ts: Date.now() };
    session.messages.push(msg);

    // Send to sender (confirm) and receiver
    socket.emit("chat:message", msg);
    const otherId = role === "talker" ? session.listenerId : session.talkerId;
    io.to(otherId).emit("chat:message", msg);

    // Send to all moderators
    moderators.forEach((modId) =>
      io.to(modId).emit("mod:message", { sessionId, msg })
    );
  });

  // ─── END SESSION ──────────────────────────────────────────────────────
  socket.on("session:end", ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) return;

    io.to(session.talkerId).emit("session:ended");
    io.to(session.listenerId).emit("session:ended");

    if (listeners[session.listenerId]) {
      listeners[session.listenerId].busy = false;
      // Notify if there's still someone in queue
      if (waitingQueue.length > 0) {
        io.to(session.listenerId).emit("listener:talker_waiting");
      }
    }

    delete sessions[sessionId];
    broadcastModeratorUpdate();
  });

  // ─── MODERATOR ────────────────────────────────────────────────────────
  socket.on("mod:join", ({ secret }) => {
    if (secret !== MODERATOR_SECRET) {
      socket.emit("error", { message: "Moderator secret salah." });
      return;
    }
    moderators.add(socket.id);
    socket.emit("mod:joined");
    broadcastModeratorUpdate();
  });

  socket.on("mod:end_session", ({ sessionId }) => {
    if (!moderators.has(socket.id)) return;
    const session = sessions[sessionId];
    if (!session) return;
    io.to(session.talkerId).emit("session:ended", { byModerator: true });
    io.to(session.listenerId).emit("session:ended", { byModerator: true });
    if (listeners[session.listenerId]) listeners[session.listenerId].busy = false;
    delete sessions[sessionId];
    broadcastModeratorUpdate();
  });

  // ─── DISCONNECT ───────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    // Clean up listener
    if (listeners[socket.id]) {
      // Find active session and end it
      const activeSession = Object.values(sessions).find((s) => s.listenerId === socket.id);
      if (activeSession) {
        io.to(activeSession.talkerId).emit("session:ended", { listenerLeft: true });
        delete sessions[activeSession.sessionId];
      }
      delete listeners[socket.id];
    }

    // Clean up talker
    if (talkers[socket.id]) {
      waitingQueue = waitingQueue.filter((id) => id !== socket.id);
      const activeSession = Object.values(sessions).find((s) => s.talkerId === socket.id);
      if (activeSession) {
        io.to(activeSession.listenerId).emit("session:ended", { talkerLeft: true });
        if (listeners[activeSession.listenerId]) listeners[activeSession.listenerId].busy = false;
        delete sessions[activeSession.sessionId];
      }
      delete talkers[socket.id];
    }

    moderators.delete(socket.id);
    broadcastModeratorUpdate();
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
