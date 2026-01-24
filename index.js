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
function createParty(hostId, name, isPublic) {
  return {
    id: uuidv4().slice(0, 6).toUpperCase(),
    hostId,
    name: name || "Music Party",
    isPublic: isPublic === true,
    queue: [],
    currentIndex: 0,
    isPlaying: false,
    startedAt: null,
    elapsed: 0,
    votesToSkip: new Set(),
    members: new Map(), // socketId -> { username, avatar }
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

function getPublicParties() {
  const publicParties = [];
  for (const party of parties.values()) {
    if (party.isPublic) {
      const currentTrack = party.queue[party.currentIndex];
      publicParties.push({
        id: party.id,
        name: party.name,
        memberCount: party.members.size,
        nowPlaying: currentTrack ? currentTrack.title : "Nothing playing"
      });
    }
  }
  return publicParties;
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

function broadcastMembersList(partyId) {
  const party = parties.get(partyId);
  if (!party) return;
  
  const membersList = Array.from(party.members.entries()).map(([id, user]) => ({
    id,
    username: user.username,
    avatar: user.avatar,
    isHost: id === party.hostId
  }));

  io.to(partyId).emit("MEMBERS_LIST", membersList);
}

// ---- Socket Logic ----
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ---------------- CREATE PARTY ----------------
  socket.on("CREATE_PARTY", (data) => {
    const name = data ? data.name : null;
    const isPublic = data ? data.isPublic : false;
    const username = data ? data.username : "Host";
    const avatar = data ? data.avatar : "👑";
    
    const party = createParty(socket.id, name, isPublic);
    parties.set(party.id, party);

    party.members.set(socket.id, { username, avatar });
    socket.join(party.id);

    socket.emit("PARTY_STATE", { ...party, isHost: true, size: party.members.size });
    broadcastPartySize(party.id);
    broadcastMembersList(party.id);

    console.log(`Party created: ${party.id} (Public: ${party.isPublic})`);
  });

  // ---------------- GET PUBLIC PARTIES ----------------
  socket.on("GET_PUBLIC_PARTIES", () => {
    socket.emit("PUBLIC_PARTIES_LIST", getPublicParties());
  });

  // ---------------- JOIN PARTY ----------------
  socket.on("JOIN_PARTY", (data) => {
    const partyId = typeof data === "string" ? data : data.partyId;
    const username =
      typeof data === "object" && data.username ? data.username : "Guest";
    const avatar =
      typeof data === "object" && data.avatar ? data.avatar : "👤";

    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    party.members.set(socket.id, { username, avatar });
    socket.join(partyId);

    socket.emit("PARTY_STATE", { ...party, isHost: false, size: party.members.size });

    io.to(partyId).emit("INFO", `${username} joined the party`);
    broadcastPartySize(partyId);
    broadcastMembersList(partyId);
    emitVoteState(partyId, party);

    console.log("User joined party:", partyId, socket.id);
  });

  // ---------------- HOST RECLAIM ----------------
  socket.on("RECONNECT_AS_HOST", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party) return;

    party.hostId = socket.id;
    // We might need to update the socket ID in the members map if it changed
    // But usually RECONNECT_AS_HOST happens on the new socket
    // If the old socket is gone, it's already removed from members via disconnect
    // So we just re-add the new one if missing, or update it.
    // However, we might not have username/avatar here if we didn't send it.
    // For simplicity, let's assume they might be missing or we use defaults/existing.
    
    // Better: Client should send username/avatar on reconnect too.
    // If not, we just set a default "Host".
    party.members.set(socket.id, { username: "Host", avatar: "👑" });
    
    socket.join(partyId);

    socket.emit("PARTY_STATE", { ...party, isHost: true, size: party.members.size });
    broadcastPartySize(partyId);
    broadcastMembersList(partyId);

    console.log("Host reclaimed party:", partyId);
  });
  
  // ---------------- KICK USER (HOST ONLY) ----------------
  socket.on("KICK_USER", ({ partyId, targetId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || socket.id !== party.hostId) return;

    if (!party.members.has(targetId)) return;
    if (targetId === party.hostId) return; // Host can't kick self

    const kickedUser = party.members.get(targetId);
    
    // Remove from party
    party.members.delete(targetId);
    party.votesToSkip.delete(targetId);

    // Notify the kicked user
    io.to(targetId).emit("KICKED", "You have been kicked by the host.");
    
    // Force disconnect their socket from the room
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.leave(partyId);
    }

    // Notify others
    io.to(partyId).emit("INFO", `${kickedUser.username} was kicked.`);
    broadcastPartySize(partyId);
    broadcastMembersList(partyId);
    emitVoteState(partyId, party);
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

  // ---------------- CHAT ----------------
  socket.on("SEND_MESSAGE", ({ partyId, message, username }) => {
    if (!message || !message.trim()) return;
    
    io.to(partyId).emit("CHAT_MESSAGE", {
      id: uuidv4(),
      senderId: socket.id,
      username: username || "Guest",
      text: message.trim(),
      timestamp: Date.now()
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
      broadcastMembersList(partyId);
      emitVoteState(partyId, party);

      if (party.hostId === socket.id) {
        const nextHostId = party.members.keys().next().value;
        if (nextHostId) {
          party.hostId = nextHostId;
          io.to(partyId).emit("HOST_UPDATE", { hostId: nextHostId });
          // Update the new host's local state or UI if needed, but IS_HOST logic on client handles it
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
