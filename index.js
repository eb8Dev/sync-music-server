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
function createParty(hostId, hostName) {
  return {
    id: uuidv4().slice(0, 6).toUpperCase(),
    hostId,
    users: new Map(), // socketId -> { name, isHost, joinedAt }
    queue: [],        // { id, url, title, addedBy, votes: number, voters: Set<socketId> }
    skipVotes: new Set(), // Set<socketId>
    
    // State
    currentIndex: 0,
    isPlaying: false,
    startedAt: null,
    isQueueLocked: false,
    
    // Metadata
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

function broadcastPartyState(partyId) {
  const party = parties.get(partyId);
  if (!party) return;

  // Convert complex objects to JSON-friendly format
  const usersList = Array.from(party.users.entries()).map(([sid, u]) => ({
    id: sid,
    name: u.name,
    isHost: u.isHost
  }));

  const queueList = party.queue.map(t => ({
    ...t,
    voters: Array.from(t.voters || []) // Convert Set to Array
  }));

  const payload = {
    id: party.id,
    hostId: party.hostId,
    users: usersList,
    queue: queueList,
    currentIndex: party.currentIndex,
    isPlaying: party.isPlaying,
    startedAt: party.startedAt,
    isQueueLocked: party.isQueueLocked,
    skipVotesCount: party.skipVotes.size,
    requiredSkipVotes: Math.ceil(party.users.size / 2) // 50% majority
  };

  io.to(partyId).emit("PARTY_STATE_UPDATE", payload);
}

// ---- Socket Logic ----
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ---------------- CREATE PARTY ----------------
  socket.on("CREATE_PARTY", (data) => {
    // Handle both old (no arg) and new (obj arg) clients
    const username = (data && data.username) ? data.username : "Host";
    
    const party = createParty(socket.id, username);
    
    // Add host to users
    party.users.set(socket.id, {
      name: username,
      isHost: true,
      joinedAt: Date.now()
    });

    parties.set(party.id, party);
    socket.join(party.id);

    // Emit initial state
    socket.emit("PARTY_CREATED", { 
      partyId: party.id, 
      isHost: true 
    });
    
    broadcastPartyState(party.id);
    console.log("Party created:", party.id, "Host:", username);
  });

  // ---------------- JOIN PARTY ----------------
  socket.on("JOIN_PARTY", ({ partyId, username }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    // Add user
    const finalName = username || "Guest";
    party.users.set(socket.id, {
      name: finalName,
      isHost: false,
      joinedAt: Date.now()
    });

    socket.join(partyId);

    socket.emit("JOINED_SUCCESS", { 
      partyId: party.id, 
      isHost: false 
    });

    broadcastPartyState(partyId);
    console.log("User joined:", partyId, finalName);
  });

  // ---------------- ADD TRACK (SEARCH & ADD) ----------------
  socket.on("ADD_TRACK", ({ partyId, track }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    // Check Lock
    if (party.isQueueLocked && socket.id !== party.hostId) {
      socket.emit("ERROR", "Queue is locked by the host.");
      return;
    }

    const user = party.users.get(socket.id);
    const addedByName = user ? user.name : "Unknown";

    const newTrack = {
      id: uuidv4(),
      url: track.url,
      title: track.title || track.url,
      addedBy: addedByName,
      addedAt: Date.now(),
      votes: 0,
      voters: new Set() // Track who voted to prevent double voting
    };

    party.queue.push(newTrack);

    broadcastPartyState(partyId); // Replaces QUEUE_UPDATED
    console.log("Track added:", newTrack.title, "Party:", partyId);
  });

  // ---------------- VOTING (DEMOCRACY) ----------------
  socket.on("VOTE_TRACK", ({ partyId, trackId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    const track = party.queue.find(t => t.id === trackId);
    if (!track) return;

    // Initialize voters set if missing (legacy)
    if (!track.voters) track.voters = new Set();

    // Toggle Vote
    if (track.voters.has(socket.id)) {
      track.voters.delete(socket.id);
      track.votes--;
    } else {
      track.voters.add(socket.id);
      track.votes++;
    }

    // Sort Queue based on votes (Excluding current and past songs)
    // We only sort from currentIndex + 1 onwards
    const past = party.queue.slice(0, party.currentIndex + 1);
    const upcoming = party.queue.slice(party.currentIndex + 1);

    upcoming.sort((a, b) => b.votes - a.votes || a.addedAt - b.addedAt);

    party.queue = [...past, ...upcoming];

    broadcastPartyState(partyId);
  });

  socket.on("VOTE_SKIP", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || !party.isPlaying) return;

    // Toggle Skip Vote
    if (party.skipVotes.has(socket.id)) {
      party.skipVotes.delete(socket.id);
    } else {
      party.skipVotes.add(socket.id);
    }

    // Check Threshold (50%)
    const threshold = Math.ceil(party.users.size / 2);
    if (party.skipVotes.size >= threshold) {
      // Trigger Skip
      io.to(partyId).emit("INFO", "Vote to skip passed!");
      party.skipVotes.clear();
      
      // Advance Track
      nextTrack(party);
    } else {
      broadcastPartyState(partyId);
    }
  });

  // ---------------- MODERATION ----------------
  socket.on("TOGGLE_LOCK", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;
    if (party.hostId !== socket.id) return;

    party.isQueueLocked = !party.isQueueLocked;
    broadcastPartyState(partyId);
  });

  socket.on("KICK_USER", ({ partyId, targetSocketId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;
    if (party.hostId !== socket.id) return;
    if (targetSocketId === party.hostId) return; // Can't kick self

    // Remove from users
    party.users.delete(targetSocketId);
    
    // Force disconnect that socket from the party
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.leave(partyId);
      targetSocket.emit("KICKED", "You have been kicked from the party.");
    }

    broadcastPartyState(partyId);
  });

  // ---------------- PLAYER CONTROLS ----------------
  socket.on("PLAY", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || party.hostId !== socket.id) return;

    if (party.queue.length === 0) return;

    party.isPlaying = true;
    party.startedAt = Date.now();
    
    broadcastPartyState(partyId);
  });

  socket.on("PAUSE", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || party.hostId !== socket.id) return;

    party.isPlaying = false;
    broadcastPartyState(partyId);
  });

  socket.on("TRACK_ENDED", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || party.hostId !== socket.id) return;
    
    nextTrack(party);
  });

  // ---------------- DISCONNECT ----------------
  socket.on("disconnect", () => {
    // Find which parties this user was in
    for (const [pid, party] of parties) {
      if (party.users.has(socket.id)) {
        party.users.delete(socket.id);
        party.skipVotes.delete(socket.id); // Remove skip vote if they leave

        // If host leaves
        if (party.hostId === socket.id) {
           // We don't delete party, but we should notify?
           // Actually, RECONNECT logic needs hostId to remain.
           // We keep hostId as is. If they come back, RECONNECT_AS_HOST works.
        }

        broadcastPartyState(pid);
        console.log("User left:", pid, socket.id);
      }
    }
  });
});

// ---- Logic Helper ----
function nextTrack(party) {
  party.currentIndex++;
  party.skipVotes.clear(); // Reset skip votes

  if (party.currentIndex >= party.queue.length) {
    party.isPlaying = false;
    party.currentIndex = 0;
  } else {
    party.isPlaying = true;
    party.startedAt = Date.now();
  }
  
  broadcastPartyState(party.id);
}

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

    // Expiration
    if (now - party.createdAt > 24 * 60 * 60 * 1000) {
       parties.delete(id);
    }
  }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});