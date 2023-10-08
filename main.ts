import { createSigner, createVerifier } from "fast-jwt";
import { RediSearchSchema, SchemaFieldTypes, createClient } from "redis";

//util
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const l = (...args: any[]) => console.log("[MX]", ...args);
// ---

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

function createToken(payload: { id: string }) {
  return tokenSigner(payload);
}
function verifyToken(token: string) {
  return tokenVerifier(token);
}
// ---

// redis
const redis = createClient();

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
  //@ts-ignore - don't need to stringify obj before setting
  return await redis.json.set(`message:${message.id}`, ".", message);
}

async function getMessage(id: string) {
  return JSON.parse(
    (await redis.json.get(`message:${id}`)) as string
  ) as Message;
}

async function getUser(id: string) {
  const result = (await redis.json.get(`user:${id}`)) as unknown;
  if (result) {
    return result as User;
  }
  return null;
}

async function saveUser(user: User) {
  //@ts-ignore - don't need to stringify obj before setting
  return await redis.json.set(`user:${user.id}`, "$", user, {
    NX: true,
  });
}

async function insertUserIntoRoom(userId: string, roomId: string) {
  return await redis.json.arrAppend(`user:${userId}`, "$.rooms", roomId);
}

async function removeUserFromRoom(
  userId: string,
  roomId: string
): Promise<string | null> {
  const index = await redis.json.arrIndex(`user:${userId}`, "$.rooms", roomId);
  if (typeof index === "number") {
    console.log("roomId not found");
    return null;
  } else {
    console.log("index", index);
    return (await redis.json.arrPop(
      `user:${userId}`,
      "$.rooms",
      index[0]
    )) as string;
  }
}

async function setUserOnlineStatus(userId: string, isOnline: boolean) {
  return await redis.json.set(`user:${userId}`, ".isOnline", isOnline);
}

redis.once("ready", async () => {
  console.log("redis connected");
  // ensure indexes
  let userIndexExists = false;
  try {
    userIndexExists = !!(await redis.ft.INFO("idx:user"));
  } catch {}
  console.log("[redis index] user exists", userIndexExists);
  if (userIndexExists) {
    await redis.ft.DROPINDEX("idx:user");
  }
  const userIndexSchema: RediSearchSchema = {
    "$.username": {
      AS: "username",
      type: SchemaFieldTypes.TEXT,
      SORTABLE: true,
    },
  };
  try {
    await redis.ft.CREATE("idx:user", userIndexSchema, {
      PREFIX: "user",
      ON: "JSON",
    });
  } catch (err) {
    console.error("[user idx error]", err);
  }
  let messageIndexExists = false;
  try {
    messageIndexExists = !!(await redis.ft.INFO("idx:message"));
  } catch {}
  console.log("[redis index] message exists", messageIndexExists);
  if (messageIndexExists) {
    await redis.ft.DROPINDEX("idx:message");
  }
  const messageIndexSchema: RediSearchSchema = {
    "$.content": { type: SchemaFieldTypes.TEXT, AS: "content" },
    "$.from": { type: SchemaFieldTypes.TAG, AS: "from" },
    "$.to": { type: SchemaFieldTypes.TAG, AS: "to" },
    "$.date": { type: SchemaFieldTypes.NUMERIC, SORTABLE: true, AS: "date" },
    "$.context": { type: SchemaFieldTypes.TAG, AS: "context" },
    "$.isDeleted": { type: SchemaFieldTypes.TAG, AS: "isDeleted" },
    "$.isRead": { type: SchemaFieldTypes.TAG, AS: "isRead" },
  };
  try {
    await redis.ft.CREATE("idx:message", messageIndexSchema, {
      PREFIX: "message",
      ON: "JSON",
    });
  } catch (err) {
    console.error("[message idx error]", err);
  }
  // ---
});
redis.once("error", (err) => {
  console.error("redis error", err);
});
await redis.connect();
// ---

interface WSData {
  id: string;
}

type WSMessage =
  | {
      type: "message";
      context: MessageContext;
      to: string;
      content: string;
      date: number;
    }
  | {
      type: "typing";
      context: MessageContext;
      to: string;
    };

const server = Bun.serve<WSData>({
  async fetch(req, server) {
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
    if (req.method === "POST" && url.pathname === "/signin") {
      const body = await req.json(); // id, name, avatar?
      // get user from db
      let user = await getUser(body?.id);
      console.log("[X]", user);
      if (!user) {
        // create user
        user = {
          id: body.id,
          username: body.username,
          avatar: body?.avatar,
          rooms: [],
          friends: [],
          isOnline: false,
          lastSeen: Date.now(),
        };
        await saveUser(user);
      }

      const token = createToken({ id: user.id });
      return new Response(JSON.stringify({ token }));
    }
    //get user?id={userId}
    if (req.method === "GET" && url.pathname === "/user") {
      const search = new URLSearchParams(url.search);
      const userId = search.get("id")!;
      const user = await getUser(userId);
      return new Response(JSON.stringify(user));
    }
    // get messages?context={context}&from={from}&to={to}&skip={skip}&limit={limit}
    if (req.method === "GET" && url.pathname === "/messages") {
      const search = new URLSearchParams(url.search);
      const context = search.get("context") as MessageContext;
      const from = search.get("from") as string;
      const to = search.get("to") as string;
      const skip = search.get("skip") ?? ("0" as string);
      const limit = search.get("limit") ?? ("10" as string);
      const messages = await redis.ft.SEARCH(
        "idx:message",
        `@context:{${context}} @from:{${from}} @to:{${to}}`,
        {
          LIMIT: {
            from: parseInt(skip),
            size: parseInt(limit),
          },
          SORTBY: "date",
        }
      );
      return new Response(JSON.stringify(messages), {
        headers: { "Content-Type": "application/json" },
      });
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
        if (!user) return ws.close();
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
            })
          )
        );
        setUserOnlineStatus(user.id, true);
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
          const msgId = `${msg.context}:${ws.data.id}:${msg.to}:${Date.now()}`;
          const message = {
            id: msgId,
            from: ws.data.id,
            to: msg.to,
            content: msg.content,
            date: Date.now(),
            context: msg.context,
            isDeleted: false,
            isRead: false,
          };
          saveMessage(message);
          if (msg.context === "dm") {
            console.log("sending dm to", msg.to);
            l(
              ws.publish(
                `user:${msg.to}`,
                JSON.stringify({
                  type: "message",
                  id: message.id,
                  from: message.from,
                  content: message.content,
                  date: message.date,
                })
              )
            );
          } else {
            console.log("sending room message to", msg.to);
            l(
              ws.publish(
                `room:${msg.to}`,
                JSON.stringify({
                  type: "message",
                  id: message.id,
                  from: message.from,
                  content: message.content,
                  date: message.date,
                })
              )
            );
          }
          // send typing event
        } else if (msg.type === "typing") {
          if (msg.context === "dm") {
            console.log("sending dm typing to", msg.to);
            l(
              ws.publish(
                `user:${msg.to}`,
                JSON.stringify({
                  type: "typing",
                  from: ws.data.id,
                })
              )
            );
          } else {
            console.log("sending room typing to", msg.to);
            l(
              ws.publish(
                `room:${msg.to}`,
                JSON.stringify({
                  type: "typing",
                  from: ws.data.id,
                })
              )
            );
          }
        }
      } catch (err) {
        console.error("[ws message error]", ws.data.id, err);
      }
    },
    //close ws
    async close(ws) {
      const user = await getUser(ws.data.id);
      if (!user) return;
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
          })
        )
      );
    },
  },
});

console.log(`Listening on ${server.hostname}:${server.port}`);
