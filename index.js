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

// ---- Socket Logic ----
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ---------------- CREATE PARTY ----------------
  socket.on("CREATE_PARTY", (data) => {
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
  socket.on("JOIN_PARTY", (data) => {
    // Support both string (old) and object (new) formats for backward compatibility during transition
    const partyId = typeof data === 'string' ? data : data.partyId;
    const username = typeof data === 'object' && data.username ? data.username : "Guest";

    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    socket.join(partyId);

    socket.emit("PARTY_STATE", {
      ...party,
      isHost: false
    });

    io.to(partyId).emit("INFO", `${username} joined the party`);
    broadcastPartySize(partyId);
    console.log("User joined party:", partyId, socket.id);
  });

  // ---------------- HOST RECLAIM ----------------
  socket.on("RECONNECT_AS_HOST", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party) return;

    console.log("Host reclaimed party:", partyId, "New host:", socket.id);
    party.hostId = socket.id;
    socket.join(partyId);
    broadcastPartySize(partyId);
  });

  // ---------------- CHANGE INDEX (HOST ONLY) ----------------
  socket.on("CHANGE_INDEX", ({ partyId, newIndex }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || socket.id !== party.hostId) return;

    if (newIndex < 0 || newIndex >= party.queue.length) return;

    party.currentIndex = newIndex;
    party.isPlaying = true; // Auto-play when changing track
    party.startedAt = Date.now();
    party.elapsed = 0;
    party.votesToSkip.clear();
    io.to(partyId).emit("VOTE_UPDATE", { votes: 0, required: 0 });

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

    const newTrack = {
      id: uuidv4(),
      url: track.url,
      title: track.title || track.url,
      addedBy: track.addedBy || "Guest", // Use provided name!
      addedAt: Date.now()
    };

    party.queue.push(newTrack);

    io.to(partyId).emit("QUEUE_UPDATED", party.queue);
    console.log("Track added:", newTrack.title, "Party:", partyId);
  });

  // ---------------- REMOVE TRACK (HOST ONLY) ----------------
  socket.on("REMOVE_TRACK", ({ partyId, trackId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || socket.id !== party.hostId) return;

    const indexToRemove = party.queue.findIndex(t => t.id === trackId);
    if (indexToRemove === -1) return;

    // Logic to handle current index
    if (indexToRemove < party.currentIndex) {
      party.currentIndex--;
    } else if (indexToRemove === party.currentIndex) {
      // If removing current track, what to do?
      // Option A: Stop playback
      // Option B: Skip to next (implemented here)
      if (party.isPlaying) {
         // This is complex because clients are playing. 
         // Simplest for now: Stop playback, let host restart.
         party.isPlaying = false;
         io.to(partyId).emit("PLAYBACK_UPDATE", { isPlaying: false });
      }
    }

    party.queue.splice(indexToRemove, 1);
    
    // Safety check if queue is now empty or index out of bounds
    // Allow staying at the end of the queue
    if (party.currentIndex > party.queue.length) {
        party.currentIndex = party.queue.length;
    }

    io.to(partyId).emit("QUEUE_UPDATED", party.queue);
    // Also emit playback update to sync index if needed
    if (indexToRemove <= party.currentIndex) {
         io.to(partyId).emit("PLAYBACK_UPDATE", {
            isPlaying: party.isPlaying,
            startedAt: party.startedAt,
            currentIndex: party.currentIndex
        });
    }

    console.log("Track removed:", trackId, "Party:", partyId);
  });

  // ---------------- VOTE SKIP ----------------
  socket.on("VOTE_SKIP", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party) return;

    const room = io.sockets.adapter.rooms.get(partyId);
    const size = room ? room.size : 0;

    if (size < 5) return; // Min 5 users required

    party.votesToSkip.add(socket.id);

    const votes = party.votesToSkip.size;
    const required = Math.ceil(size * 0.8);

    io.to(partyId).emit("VOTE_UPDATE", { votes, required });

    if (votes >= required) {
      // Skip Track Logic
      party.currentIndex++;
      party.elapsed = 0;
      party.votesToSkip.clear();
      
      // Notify vote reset
      io.to(partyId).emit("VOTE_UPDATE", { votes: 0, required });

      if (party.currentIndex >= party.queue.length) {
        party.isPlaying = false;
        // Stay at end of queue
        io.to(partyId).emit("PLAYBACK_UPDATE", { 
          isPlaying: false, 
          currentIndex: party.currentIndex 
        });
      } else {
        party.isPlaying = true;
        party.startedAt = Date.now();
        io.to(partyId).emit("PLAYBACK_UPDATE", {
          isPlaying: true,
          startedAt: party.startedAt,
          currentIndex: party.currentIndex
        });
      }
      io.to(partyId).emit("INFO", "Skipped by vote!");
    }
  });

  // ---------------- PLAY (HOST ONLY) ----------------
  socket.on("PLAY", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || socket.id !== party.hostId) return;

    if (party.queue.length === 0) return;

    party.isPlaying = true;
    // Resume from elapsed time (default 0)
    party.startedAt = Date.now() - (party.elapsed || 0);

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: true,
      startedAt: party.startedAt,
      currentIndex: party.currentIndex
    });
  });

  // ---------------- PAUSE (HOST ONLY) ----------------
  socket.on("PAUSE", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || socket.id !== party.hostId) return;

    party.isPlaying = false;
    if (party.startedAt) {
      party.elapsed = Date.now() - party.startedAt;
    }

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: false
    });
  });

  // ---------------- TRACK ENDED (HOST ONLY) ----------------
  socket.on("TRACK_ENDED", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || socket.id !== party.hostId) return;

    party.currentIndex++;
    party.elapsed = 0;
    party.votesToSkip.clear();
    io.to(partyId).emit("VOTE_UPDATE", { votes: 0, required: 0 });

    if (party.currentIndex >= party.queue.length) {
      party.isPlaying = false;
      // Stay at end of queue
      io.to(partyId).emit("PLAYBACK_UPDATE", { 
        isPlaying: false,
        currentIndex: party.currentIndex
      });
    } else {
      party.isPlaying = true;
      party.startedAt = Date.now();
      io.to(partyId).emit("PLAYBACK_UPDATE", {
        isPlaying: true,
        startedAt: party.startedAt,
        currentIndex: party.currentIndex
      });
    }
  });

  socket.on("END_PARTY", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party) return;

    // Only host can end party
    if (party.hostId !== socket.id) return;

    // Notify everyone
    io.to(partyId).emit("PARTY_ENDED", {
      message: "The host has ended the party.",
    });

    // Kick everyone out of the room
    const room = io.sockets.adapter.rooms.get(partyId);
    if (room) {
      for (const socketId of room) {
        const s = io.sockets.sockets.get(socketId);
        s?.leave(partyId);
      }
    }

    // Delete party
    parties.delete(partyId);

        console.log("Party ended:", partyId);

      });

    

      // ---------------- REACTIONS ----------------

      socket.on("SEND_REACTION", ({ partyId, emoji }) => {

        // Validate emoji to prevent spam/abuse if necessary

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
    
    // Check if the disconnected user was a host of any party
    for (const [partyId, party] of parties) {
      broadcastPartySize(partyId);
      if (party.hostId === socket.id) {
        // Find a new host
        const room = io.sockets.adapter.rooms.get(partyId);
        if (room && room.size > 0) {
          // Pick the first client in the room as the new host
          const newHostId = room.values().next().value;
          party.hostId = newHostId;
          
          console.log(`Host migrated in party ${partyId}. New host: ${newHostId}`);
          
          // Notify everyone about the new host
          io.to(partyId).emit("HOST_UPDATE", { hostId: newHostId });
          
          // Also verify if the socket object for new host is available to emit specific events if needed
          // (Not strictly necessary if clients listen to HOST_UPDATE)
        } else {
          console.log(`Party ${partyId} is now empty.`);
          // Optionally delete the party or wait for the cleanup interval
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
      io.to(party.id).emit("SYNC", {
        serverTime: now,
        startedAt: party.startedAt,
        currentIndex: party.currentIndex
      });
    }
    // Auto-delete after 24h
    if (now - party.createdAt > 24 * 60 * 60 * 1000) {
      parties.delete(id);
    }
  }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

function broadcastPartySize(partyId) {
  const room = io.sockets.adapter.rooms.get(partyId);
  const size = room ? room.size : 0;
  io.to(partyId).emit("PARTY_SIZE", { size });
}
