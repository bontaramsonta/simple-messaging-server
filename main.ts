import { createSigner, createVerifier } from "fast-jwt";
import { createClient } from "redis";

//util
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const l = (...args: any[]) => console.log("[MX]", ...args);
// ---

// types

// jwt
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
  id: string;
}) {
  return tokenSigner(payload);
}
function verifyToken(token: string) {
  return tokenVerifier(token);
}
// ---

// redis
const redis = createClient();
redis.once("ready", () => {
  console.log("redis connected");
});
redis.once("error", (err) => {
  console.error("redis error", err);
});

type MessageContext = "dm" | "room";

interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  date: number;
  context: MessageContext;
  isDeleted: boolean;
  isRead: boolean;
}

interface User {
  id: string;
  username: string;
  avatar: string;
  rooms: string[];
  friends: string[];
  isOnline: boolean;
  lastSeen: number;
}

async function saveMessage(message: Message) {
  return await redis.json.set(
    `message:${message.id}`,
    ".",
    JSON.stringify(message),
  );
}

async function getMessage(id: string) {
  return JSON.parse(await redis.json.get(`message:${id}`) as string) as Message;
}

async function getUser(id: string) {
  return JSON.parse(await redis.json.get(`user:${id}`) as string) as User;
}

async function insertUserIntoRoom(userId: string, roomId: string) {
  return await redis.json.arrAppend(`user:${userId}`, ".rooms", roomId);
}

async function removeUserFromRoom(
  userId: string,
  roomId: string,
): Promise<string | null> {
  const index = await redis.json.arrIndex(`user:${userId}`, ".rooms", roomId);
  if (typeof index === "number") {
    console.log("roomId not found");
    return null;
  } else {
    console.log("index", index);
    return await redis.json.arrPop(
      `user:${userId}`,
      ".rooms",
      index[0],
    ) as string;
  }
}

async function setUserOnlineStatus(userId: string, isOnline: boolean) {
  return await redis.json.set(
    `user:${userId}`,
    ".isOnline",
    isOnline,
  );
}

await redis.connect();
// ---

interface WSData {
  id: string;
}

type WSMessage = {
  type: "message";
  context: MessageContext;
  to: string;
  from: string;
  content: string;
  date: number;
} | {
  type: "typing";
  context: MessageContext;
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
      const success = server.upgrade(req, {
        data: {
          id: payload.id,
        },
      });
      return success
        ? undefined
        : new Response("WebSocket upgrade error", { status: 400 });
    }
    //token create
    if (req.method === "POST" && url.pathname === "/token") {
      const body = await req.json(); // id

      const token = createToken({ id: body.id });
      return new Response(JSON.stringify({ token }));
    }

    return new Response(`ok ${Date.now()}`);
  },
  websocket: {
    backpressureLimit: 1024 * 1024 * 1024, // 1GB
    //open ws
    async open(ws) {
      try {
        // get user for db
        const user = await getUser(ws.data.id);
        console.log(`${user.username} has entered the chat`);
        ws.subscribe(`user:${user.id}`);
        // sub to rooms
        user.rooms.forEach((room) => ws.subscribe(`room:${room}`));
        // publish in all rooms that user is online
        user.rooms.forEach((room) =>
          ws.publish(
            `room:${room}`,
            JSON.stringify({
              type: "user-online",
              userId: user.id,
              username: user.username,
              avatar: user.avatar,
            }),
          )
        );
      } catch (err) {
        console.error("[ws open error]", ws.data.id, err);
      }
    },
    //message ws
    message(ws, message: string) {
      try {
        console.log("message from", ws.data.id, ":", message);
        // parse message
        const msg = JSON.parse(message) as WSMessage;
        // send message event
        if (msg.type === "message") {
          // save message
          const msgId = `${msg.context}:${msg.from}:${msg.to}:${Date.now()}`;
          saveMessage({
            id: msgId,
            from: msg.from,
            to: msg.to,
            content: msg.content,
            date: msg.date,
            context: msg.context,
            isDeleted: false,
            isRead: false,
          });
          if (msg.context === "dm") {
            console.log("sending dm to", msg.to);
            l(ws.publish(
              `user:${msg.to}`,
              JSON.stringify({
                type: "message",
                id: msgId,
                from: ws.data.id,
                content: msg.content,
                date: msg.date,
              }),
            ));
          } else {
            console.log("sending room message to", msg.to);
            l(ws.publish(
              `room:${msg.to}`,
              JSON.stringify({
                type: "message",
                id: msgId,
                from: ws.data.id,
                content: msg.content,
                date: Date.now(),
              }),
            ));
          }
          // send typing event
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
        console.error("[ws message error]", ws.data.id, err);
      }
    },
    //close ws
    async close(ws) {
      const user = await getUser(ws.data.id);
      console.log(`${user.username} has left the chat`);
      // set user offline
      setUserOnlineStatus(user.id, false);
      // publish in all rooms that user is offline
      user.rooms.forEach((room) =>
        ws.publish(
          `room:${room}`,
          JSON.stringify({
            type: "user-offline",
            userId: user.id,
          }),
        )
      );
    },
  },
});

console.log(`Listening on ${server.hostname}:${server.port}`);
