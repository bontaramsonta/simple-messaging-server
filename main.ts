import { createSigner, createVerifier } from "fast-jwt";
import { createClient } from "redis";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const l = (...args: any[]) => console.log("[MX]", ...args);

const tokenSigner = createSigner({
  algorithm: "HS256",
  key: "secret",
  aud: "message-server",
  iss: "message-server",
  expiresIn: 1000 * 60 * 60 * 24 * 7, // 7 days
});

const tokenVerifier = createVerifier({
  algorithms: ["HS256"],
  key: "secret",
  allowedAud: "message-server",
  allowedIss: "message-server",
  ignoreExpiration: false,
  cache: true,
  complete: true,
});

function createToken(payload: {
  userId: string;
  username: string;
  avatar: string;
}) {
  return tokenSigner(payload);
}
function verifyToken(token: string) {
  return tokenVerifier(token);
}

const redis = createClient();
redis.once("ready", () => {
  console.log("redis connected");
});
redis.once("error", (err) => {
  console.error("redis error", err);
});

await redis.connect();

interface WSData {
  id: string;
  username: string;
  avatar: string;
  rooms: string[];
}

type WSMessage = {
  type: "message";
  context: "dm" | "room";
  to: string;
  from: string;
  content: string;
  date: number;
} | {
  type: "typing";
  context: "dm" | "room";
  to: string;
  from: string;
};

const server = Bun.serve<WSData>({
  async fetch(req, server) {
    console.log("request", req.url);
    const url = new URL(req.url);
    if (url.pathname === "/chat") {
      const search = new URLSearchParams(req.url.split("?")[1]);
      if (!search.get("auth")) {
        return new Response("Unauthorized", { status: 401 });
      }
      const token = search.get("auth")!;
      const { payload } = verifyToken(token);
      const rooms = search.get("rooms")?.split(",") ?? [];

      const success = server.upgrade(req, {
        data: {
          id: payload.userId,
          username: payload.username,
          avatar: payload.avatar,
          rooms,
        },
      });
      return success
        ? undefined
        : new Response("WebSocket upgrade error", { status: 400 });
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const body = await req.json(); // id, username, avatar?

      const token = createToken({
        userId: body.id,
        username: body.username,
        avatar: body?.avatar ?? "",
      });
      return new Response(JSON.stringify({ token }));
    }

    return new Response(`ok ${Date.now()}`);
  },
  websocket: {
    backpressureLimit: 1024 * 1024 * 1024, // 1GB
    open(ws) {
      console.log(`${ws.data.id} has entered the chat`);
      ws.subscribe(`user:${ws.data.id}`);
      // sub to rooms
      ws.data.rooms.forEach((room) => ws.subscribe(`room:${room}`));
      // publish in all rooms that user is online
      ws.data.rooms.forEach((room) =>
        ws.publish(
          `room:${room}`,
          JSON.stringify({
            type: "user-online",
            userId: ws.data.id,
            username: ws.data.username,
            avatar: ws.data.avatar,
          }),
        )
      );
    },
    message(ws, message: string) {
      try {
        console.log("message from", ws.data.id, ":", message);
        // parse message
        const msg = JSON.parse(message) as WSMessage;
        // send message event
        if (msg.type === "message") {
          if (msg.context === "dm") {
            console.log("sending dm to", msg.to);
            l(ws.publish(
              `user:${msg.to}`,
              JSON.stringify({
                type: "message",
                from: ws.data.id,
                content: msg.content,
                date: Date.now(),
              }),
            ));
          } else {
            console.log("sending room message to", msg.to);
            l(ws.publish(
              `room:${msg.to}`,
              JSON.stringify({
                type: "message",
                from: ws.data.id,
                content: msg.content,
                date: Date.now(),
              }),
            ));
          }
          // typing indication event
        } else if (msg.type === "typing") {
          if (msg.context === "dm") {
            console.log("sending dm typing to", msg.to);
            l(ws.publish(
              `user:${msg.to}`,
              JSON.stringify({
                type: "typing",
                from: ws.data.id,
              }),
            ));
          } else {
            console.log("sending room typing to", msg.to);
            l(ws.publish(
              `room:${msg.to}`,
              JSON.stringify({
                type: "typing",
                from: ws.data.id,
              }),
            ));
          }
        }
      } catch (err) {
        console.error(err);
      }
    },
    close(ws) {
      console.log(`${ws.data.username} has left the chat`);
      // publish in all rooms that user is offline
      ws.data.rooms.forEach((room) =>
        ws.publish(
          `room:${room}`,
          JSON.stringify({
            type: "user-offline",
            userId: ws.data.id,
          }),
        )
      );
    },
  },
});

console.log(`Listening on ${server.hostname}:${server.port}`);
