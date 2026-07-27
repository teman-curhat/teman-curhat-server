const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);

const LISTENER_SECRET = process.env.LISTENER_SECRET || "listener123";
const MODERATOR_SECRET = process.env.MODERATOR_SECRET || "mod999";

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: false },
  allowEIO3: true,
});

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/", (req, res) => res.send("Teman Curhat Server OK"));

let listeners = {};
let talkers = {};
let sessions = {};
let waitingQueue = [];
let moderators = new Set();

function getAvailableListener() {
  return Object.values(listeners).find((l) => !l.busy);
}

function isInSession(socketId) {
  return Object.values(sessions).some(
    (s) => s.talkerId === socketId || s.listenerId === socketId
  );
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

function endSessionCleanup(sessionId, reason = {}) {
  const session = sessions[sessionId];
  if (!session) return;
  io.to(session.talkerId).emit("session:ended", reason);
  io.to(session.listenerId).emit("session:ended", reason);
  if (listeners[session.listenerId]) {
    listeners[session.listenerId].busy = false;
    if (waitingQueue.length > 0) {
      io.to(session.listenerId).emit("listener:talker_waiting");
    }
  }
  if (talkers[session.talkerId]) {
    talkers[session.talkerId].sessionId = null;
  }
  delete sessions[sessionId];
  broadcastModeratorUpdate();
}

io.on("connection", (socket) => {

  socket.on("listener:join", ({ secret, alias }) => {
    if (secret !== LISTENER_SECRET) {
      socket.emit("error", { message: "Kode rahasia salah." });
      return;
    }
    if (listeners[socket.id]) return;
    listeners[socket.id] = { socketId: socket.id, alias: alias || "Listener", busy: false };
    socket.emit("listener:joined", { alias: listeners[socket.id].alias });
    broadcastModeratorUpdate();
    if (waitingQueue.length > 0) {
      socket.emit("listener:talker_waiting");
    }
  });

  socket.on("listener:accept", () => {
    const listener = listeners[socket.id];
    if (!listener || listener.busy) return;

    let talkerId = null;
    while (waitingQueue.length > 0) {
      const candidate = waitingQueue.shift();
      if (talkers[candidate] && !isInSession(candidate)) {
        talkerId = candidate;
        break;
      }
    }

    if (!talkerId) {
      socket.emit("listener:no_talker");
      return;
    }

    const sessionId = uuidv4();
    listener.busy = true;
    talkers[talkerId].sessionId = sessionId;
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

  socket.on("listener:reject", () => {
    if (waitingQueue.length > 0) {
      socket.emit("listener:talker_waiting");
    }
  });

  socket.on("talker:join", () => {
    if (talkers[socket.id]) {
      waitingQueue = waitingQueue.filter((id) => id !== socket.id);
      const oldSession = Object.values(sessions).find((s) => s.talkerId === socket.id);
      if (oldSession) endSessionCleanup(oldSession.sessionId, {});
      delete talkers[socket.id];
    }

    talkers[socket.id] = { socketId: socket.id, sessionId: null };
    waitingQueue.push(socket.id);

    const available = getAvailableListener();
    if (available) {
      io.to(available.socketId).emit("listener:talker_waiting");
      socket.emit("talker:waiting");
    } else {
      socket.emit("talker:queued");
    }
    broadcastModeratorUpdate();
  });

  socket.on("chat:message", ({ sessionId, text }) => {
    const session = sessions[sessionId];
    if (!session) return;
    if (session.talkerId !== socket.id && session.listenerId !== socket.id) return;

    const role = session.talkerId === socket.id ? "talker" : "listener";
    const msg = { role, text, ts: Date.now() };
    session.messages.push(msg);

    // Kirim hanya ke pihak lain
    const otherId = role === "talker" ? session.listenerId : session.talkerId;
    io.to(otherId).emit("chat:message", msg);

    moderators.forEach((modId) =>
      io.to(modId).emit("mod:message", { sessionId, msg })
    );
  });

  socket.on("session:end", ({ sessionId }) => {
    if (!sessions[sessionId]) return;
    const s = sessions[sessionId];
    if (s.talkerId !== socket.id && s.listenerId !== socket.id) return;
    endSessionCleanup(sessionId, {});
  });

  socket.on("mod:join", ({ secret }) => {
    if (secret !== MODERATOR_SECRET) {
      socket.emit("error", { message: "Password moderator salah." });
      return;
    }
    moderators.add(socket.id);
    socket.emit("mod:joined");
    broadcastModeratorUpdate();
  });

  socket.on("mod:end_session", ({ sessionId }) => {
    if (!moderators.has(socket.id)) return;
    endSessionCleanup(sessionId, { byModerator: true });
  });

  socket.on("disconnect", () => {
    if (listeners[socket.id]) {
      const activeSession = Object.values(sessions).find((s) => s.listenerId === socket.id);
      if (activeSession) endSessionCleanup(activeSession.sessionId, { listenerLeft: true });
      delete listeners[socket.id];
    }

    if (talkers[socket.id]) {
      waitingQueue = waitingQueue.filter((id) => id !== socket.id);
      const activeSession = Object.values(sessions).find((s) => s.talkerId === socket.id);
      if (activeSession) endSessionCleanup(activeSession.sessionId, { talkerLeft: true });
      delete talkers[socket.id];
    }

    moderators.delete(socket.id);
    broadcastModeratorUpdate();
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log("Server running on port " + PORT));
