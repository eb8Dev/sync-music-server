const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// In-memory party store
const parties = new Map();

// ---- Models ----
function createParty(hostId) {
  return {
    id: uuidv4().slice(0, 6).toUpperCase(),
    hostId,
    queue: [],
    currentIndex: 0,
    isPlaying: false,
    startedAt: null
  };
}

// ---- Helpers ----
function getPartyOrError(socket, partyId) {
  const party = parties.get(partyId);
  if (!party) {
    socket.emit("ERROR", "Party not found");
    return null;
  }
  return party;
}

// ---- Socket Logic ----
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ---------------- CREATE PARTY ----------------
  socket.on("CREATE_PARTY", () => {
    const party = createParty(socket.id);
    parties.set(party.id, party);

    socket.join(party.id);

    socket.emit("PARTY_STATE", {
      ...party,
      isHost: true
    });

    console.log("Party created:", party.id, "Host:", socket.id);
  });

  // ---------------- JOIN PARTY ----------------
  socket.on("JOIN_PARTY", (partyId) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    socket.join(partyId);

    socket.emit("PARTY_STATE", {
      ...party,
      isHost: false
    });

    io.to(partyId).emit("INFO", "Someone joined the party");
    console.log("User joined party:", partyId, socket.id);
  });

  // ---------------- HOST RECLAIM (Reconnect Fix) ----------------
  socket.on("RECONNECT_AS_HOST", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party) return;

    console.log("Host reclaimed party:", partyId, "New host:", socket.id);
    party.hostId = socket.id;
  });

  // ---------------- ADD TRACK ----------------
  socket.on("ADD_TRACK", ({ partyId, track }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    const isHost = socket.id === party.hostId;

    const newTrack = {
      id: uuidv4(),
      url: track.url,
      title: track.title || track.url,
      addedBy: isHost ? "Host" : "Guest",
      addedAt: Date.now()
    };

    party.queue.push(newTrack);

    io.to(partyId).emit("QUEUE_UPDATED", party.queue);
    console.log("Track added:", newTrack.title, "Party:", partyId);
  });

  // ---------------- PLAY (HOST ONLY) ----------------
  socket.on("PLAY", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    console.log("PLAY from:", socket.id);
    console.log("Host is:", party.hostId);

    if (socket.id !== party.hostId) {
      console.log("PLAY rejected: not host");
      return;
    }

    if (party.queue.length === 0) {
      console.log("PLAY blocked: empty queue");
      return;
    }

    party.isPlaying = true;
    party.startedAt = Date.now();

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: true,
      startedAt: party.startedAt,
      currentIndex: party.currentIndex
    });

    console.log("Playback started:", partyId);
  });

  // ---------------- PAUSE (HOST ONLY) ----------------
  socket.on("PAUSE", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    if (socket.id !== party.hostId) {
      console.log("PAUSE rejected: not host");
      return;
    }

    party.isPlaying = false;

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: false
    });

    console.log("Playback paused:", partyId);
  });

  // ---------------- REMOVE TRACK (HOST ONLY) ----------------
  socket.on("REMOVE_TRACK", ({ partyId, trackId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    if (socket.id !== party.hostId) {
      console.log("REMOVE rejected: not host");
      return;
    }

    party.queue = party.queue.filter(t => t.id !== trackId);

    io.to(partyId).emit("QUEUE_UPDATED", party.queue);
    console.log("Track removed:", trackId, "Party:", partyId);
  });

  // ---------------- TRACK ENDED (HOST ONLY) ----------------
  socket.on("TRACK_ENDED", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    if (socket.id !== party.hostId) return;

    party.currentIndex++;

    if (party.currentIndex >= party.queue.length) {
      party.isPlaying = false;
      party.currentIndex = 0;

      io.to(partyId).emit("PLAYBACK_UPDATE", {
        isPlaying: false
      });

      console.log("Queue finished:", partyId);
      return;
    }

    party.startedAt = Date.now();

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: true,
      startedAt: party.startedAt,
      currentIndex: party.currentIndex
    });

    console.log("Next track:", party.currentIndex, "Party:", partyId);
  });

  // ---------------- DISCONNECT ----------------
  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    for (const [id, party] of parties) {
      if (party.hostId === socket.id) {
        parties.delete(id);
        io.to(id).emit("ERROR", "Host left. Party closed.");
        console.log("Party closed:", id);
      }
    }
  });
});

// ---------------- SYNC LOOP ----------------
setInterval(() => {
  for (const party of parties.values()) {
    if (!party.isPlaying) continue;

    io.to(party.id).emit("SYNC", {
      serverTime: Date.now(),
      startedAt: party.startedAt,
      currentIndex: party.currentIndex
    });
  }
}, 5000);

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
