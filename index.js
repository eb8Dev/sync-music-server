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
    startedAt: null,
    elapsed: 0,
    votesToSkip: new Set(),
    members: new Set(),
    createdAt: Date.now(),
    lastActiveAt: Date.now()
  };
}

// ---- Helpers ----
function getPartyOrError(socket, partyId) {
  const party = parties.get(partyId);
  if (!party) {
    socket.emit("ERROR", "Party not found");
    return null;
  }
  party.lastActiveAt = Date.now();
  return party;
}

function emitVoteState(partyId, party) {
  const size = party.members.size;
  const enabled = size >= 5;
  const required = enabled ? Math.ceil(size * 0.8) : 0;

  io.to(partyId).emit("VOTE_UPDATE", {
    votes: party.votesToSkip.size,
    required,
    enabled
  });
}

function broadcastPartySize(partyId) {
  const party = parties.get(partyId);
  if (!party) return;
  io.to(partyId).emit("PARTY_SIZE", { size: party.members.size });
}

// ---- Socket Logic ----
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ---------------- CREATE PARTY ----------------
  socket.on("CREATE_PARTY", () => {
    const party = createParty(socket.id);
    parties.set(party.id, party);

    party.members.add(socket.id);
    socket.join(party.id);

    socket.emit("PARTY_STATE", { ...party, isHost: true });
    broadcastPartySize(party.id);

    console.log("Party created:", party.id);
  });

  // ---------------- JOIN PARTY ----------------
  socket.on("JOIN_PARTY", (data) => {
    const partyId = typeof data === "string" ? data : data.partyId;
    const username =
      typeof data === "object" && data.username ? data.username : "Guest";

    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    party.members.add(socket.id);
    socket.join(partyId);

    socket.emit("PARTY_STATE", { ...party, isHost: false });

    io.to(partyId).emit("INFO", `${username} joined the party`);
    broadcastPartySize(partyId);
    emitVoteState(partyId, party);

    console.log("User joined party:", partyId, socket.id);
  });

  // ---------------- HOST RECLAIM ----------------
  socket.on("RECONNECT_AS_HOST", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party) return;

    party.hostId = socket.id;
    party.members.add(socket.id);
    socket.join(partyId);

    socket.emit("PARTY_STATE", { ...party, isHost: true });
    broadcastPartySize(partyId);

    console.log("Host reclaimed party:", partyId);
  });

  // ---------------- CHANGE INDEX (HOST ONLY) ----------------
  socket.on("CHANGE_INDEX", ({ partyId, newIndex }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || socket.id !== party.hostId) return;
    if (newIndex < 0 || newIndex >= party.queue.length) return;

    party.currentIndex = newIndex;
    party.isPlaying = true;
    party.startedAt = Date.now();
    party.elapsed = 0;
    party.votesToSkip.clear();

    emitVoteState(partyId, party);

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: true,
      startedAt: party.startedAt,
      currentIndex: party.currentIndex
    });
  });

  // ---------------- ADD TRACK ----------------
  socket.on("ADD_TRACK", ({ partyId, track }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    party.queue.push({
      id: uuidv4(),
      url: track.url,
      title: track.title || track.url,
      addedBy: track.addedBy || "Guest",
      addedAt: Date.now()
    });

    io.to(partyId).emit("QUEUE_UPDATED", party.queue);
  });

  // ---------------- REMOVE TRACK (HOST ONLY) ----------------
  socket.on("REMOVE_TRACK", ({ partyId, trackId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || socket.id !== party.hostId) return;

    const index = party.queue.findIndex(t => t.id === trackId);
    if (index === -1) return;

    if (index < party.currentIndex) {
      party.currentIndex--;
    } else if (index === party.currentIndex) {
      party.isPlaying = false;
    }

    party.queue.splice(index, 1);

    if (party.currentIndex > party.queue.length) {
      party.currentIndex = party.queue.length;
    }

    io.to(partyId).emit("QUEUE_UPDATED", party.queue);
    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: party.isPlaying,
      startedAt: party.startedAt,
      currentIndex: party.currentIndex
    });
  });

  // ---------------- VOTE SKIP ----------------
  socket.on("VOTE_SKIP", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party) return;

    const size = party.members.size;
    if (size < 5) return;

    party.votesToSkip.add(socket.id);
    emitVoteState(partyId, party);

    const required = Math.ceil(size * 0.8);
    if (party.votesToSkip.size < required) return;

    party.votesToSkip.clear();

    if (party.currentIndex < party.queue.length - 1) {
      party.currentIndex++;
      party.startedAt = Date.now();
      party.isPlaying = true;
    } else {
      party.isPlaying = false;
    }

    emitVoteState(partyId, party);

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: party.isPlaying,
      startedAt: party.startedAt,
      currentIndex: party.currentIndex
    });

    io.to(partyId).emit("INFO", "Skipped by vote!");
  });

  // ---------------- PLAY / PAUSE / TRACK ENDED ----------------
  socket.on("PLAY", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || socket.id !== party.hostId) return;

    party.isPlaying = true;
    party.startedAt = Date.now() - (party.elapsed || 0);

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: true,
      startedAt: party.startedAt,
      currentIndex: party.currentIndex
    });
  });

  socket.on("PAUSE", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || socket.id !== party.hostId) return;

    party.isPlaying = false;
    party.elapsed = Date.now() - party.startedAt;

    io.to(partyId).emit("PLAYBACK_UPDATE", { isPlaying: false });
  });

  socket.on("TRACK_ENDED", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || socket.id !== party.hostId) return;

    party.currentIndex++;
    party.elapsed = 0;
    party.votesToSkip.clear();

    emitVoteState(partyId, party);

    if (party.currentIndex >= party.queue.length) {
      party.isPlaying = false;
    } else {
      party.isPlaying = true;
      party.startedAt = Date.now();
    }

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: party.isPlaying,
      startedAt: party.startedAt,
      currentIndex: party.currentIndex
    });
  });

  // ---------------- END PARTY ----------------
  socket.on("END_PARTY", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party || party.hostId !== socket.id) return;

    io.to(partyId).emit("PARTY_ENDED", {
      message: "The host has ended the party."
    });

    parties.delete(partyId);
  });

  // ---------------- REACTIONS ----------------
  socket.on("SEND_REACTION", ({ partyId, emoji }) => {
    const allowed = ["🔥", "❤️", "🎉", "😂", "👋", "💃"];
    if (!allowed.includes(emoji)) return;

    io.to(partyId).emit("REACTION", {
      emoji,
      senderId: socket.id
    });
  });

  // ---------------- DISCONNECT ----------------
  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    for (const [partyId, party] of parties) {
      if (!party.members.has(socket.id)) continue;

      party.members.delete(socket.id);
      party.votesToSkip.delete(socket.id);

      broadcastPartySize(partyId);
      emitVoteState(partyId, party);

      if (party.hostId === socket.id) {
        const nextHost = [...party.members][0];
        if (nextHost) {
          party.hostId = nextHost;
          io.to(partyId).emit("HOST_UPDATE", { hostId: nextHost });
        }
      }
    }
  });
});

// ---------------- SYNC LOOP ----------------
setInterval(() => {
  const now = Date.now();
  for (const [id, party] of parties) {
    if (party.isPlaying) {
      io.to(id).emit("SYNC", {
        serverTime: now,
        startedAt: party.startedAt,
        currentIndex: party.currentIndex
      });
    }
    if (now - party.createdAt > 24 * 60 * 60 * 1000) {
      parties.delete(id);
    }
  }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
