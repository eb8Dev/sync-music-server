const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

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

// ---- Socket Logic ----
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // CREATE PARTY
  socket.on("CREATE_PARTY", () => {
    const party = createParty(socket.id);
    parties.set(party.id, party);

    socket.join(party.id);
    socket.emit("PARTY_STATE", party);

    console.log("Party created:", party.id);
  });

  // JOIN PARTY
  socket.on("JOIN_PARTY", (partyId) => {
    const party = parties.get(partyId);
    if (!party) {
      return socket.emit("ERROR", "Party not found");
    }

    socket.join(partyId);
    socket.emit("PARTY_STATE", party);

    io.to(partyId).emit("INFO", "Someone joined the party");
  });

  // ADD TRACK
  socket.on("ADD_TRACK", ({ partyId, track }) => {
    const party = parties.get(partyId);
    if (!party) return;

    party.queue.push({
      id: uuidv4(),
      ...track,
      addedAt: Date.now()
    });

    io.to(partyId).emit("QUEUE_UPDATED", party.queue);
  });

  // PLAY (HOST ONLY)
  socket.on("PLAY", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party || socket.id !== party.hostId) return;

    party.isPlaying = true;
    party.startedAt = Date.now();

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: true,
      startedAt: party.startedAt,
      currentIndex: party.currentIndex
    });
  });

  // PAUSE
  socket.on("PAUSE", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party || socket.id !== party.hostId) return;

    party.isPlaying = false;

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: false
    });
  });

  // REMOVE TRACK (HOST ONLY)
  socket.on("REMOVE_TRACK", ({ partyId, trackId }) => {
    const party = parties.get(partyId);
    if (!party || socket.id !== party.hostId) return;

    party.queue = party.queue.filter(t => t.id !== trackId);
    io.to(partyId).emit("QUEUE_UPDATED", party.queue);
  });

  // TRACK ENDED
  socket.on("TRACK_ENDED", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party || socket.id !== party.hostId) return;

    party.currentIndex++;
    party.startedAt = Date.now();

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: true,
      startedAt: party.startedAt,
      currentIndex: party.currentIndex
    });
  });

  // CLEANUP
  socket.on("disconnect", () => {
    for (const [id, party] of parties) {
      if (party.hostId === socket.id) {
        parties.delete(id);
        io.to(id).emit("ERROR", "Host left. Party closed.");
      }
    }
  });
});

// ---- SYNC LOOP ----
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

// ---- Start ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on", PORT);
});
