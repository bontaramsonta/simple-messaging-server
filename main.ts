import { createSigner, createVerifier } from "fast-jwt";
import { RediSearchSchema, SchemaFieldTypes, createClient } from "redis";
import { customAlphabet } from "nanoid";

const userIdGenerator = customAlphabet(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
  10
);

const messageIdGenerator = customAlphabet(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
  21
);

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
  lastSeen: number;
  isBanned: boolean;
}

async function saveMessage(message: Message) {
  //@ts-ignore - don't need to stringify obj before setting
  return await redis.json.set(`message:${message.id}`, ".", message);
}

async function markMessageAsRead(messageId: string) {
  return await redis.json.set(`message:${messageId}`, "$.isRead", true);
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
async function updateLastSeen(userId: string) {
  return await redis.json.set(`user:${userId}`, "$.lastSeen", Date.now());
}

async function addFriend(userId: string, friendId: string) {
  return await redis.json.arrAppend(`user:${userId}`, "$.friends", friendId);
}

async function insertUserIntoRoom(userId: string, roomId: string) {
  return await redis.json.arrAppend(`user:${userId}`, "$.rooms", roomId);
}

async function removeFriend(userId: string, friendId: string) {
  const index = await redis.json.arrIndex(
    `user:${userId}`,
    "$.friends",
    friendId
  );
  if (typeof index === "number") {
    console.log("friendId not found");
    return null;
  } else {
    console.log("index", index);
    return (await redis.json.arrPop(
      `user:${userId}`,
      "$.friends",
      index[0]
    )) as string;
  }
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

redis.once("ready", async () => {
  console.log("redis connected");
  // ensure indexes
  const RE_WRITE_INDEXES = process.env.RE_WRITE_INDEXES ?? false;
  let userIndexExists = false;
  try {
    userIndexExists = !!(await redis.ft.INFO("idx:user"));
  } catch {}
  console.log("[redis index] user exists", userIndexExists);
  if (!userIndexExists || RE_WRITE_INDEXES) {
    console.log(
      `[redis index] ${RE_WRITE_INDEXES ? "force" : ""} creating user index`
    );
    await redis.ft.DROPINDEX("idx:user");
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
  }
  let messageIndexExists = false;
  try {
    messageIndexExists = !!(await redis.ft.INFO("idx:message"));
  } catch {}
  console.log("[redis index] message exists", messageIndexExists);
  if (messageIndexExists || RE_WRITE_INDEXES) {
    console.log(
      `[redis index] ${RE_WRITE_INDEXES ? "force" : ""} creating message index`
    );
    await redis.ft.DROPINDEX("idx:message");
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
      type: "action";
      action: "typing";
      context: MessageContext;
      to: string;
    }
  | {
      type: "action";
      action: "read";
      messageId: string;
    }
  | { type: "ping" };

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
    // ping
    else if (req.method === "GET" && url.pathname === "/") {
      return new Response(`ok ${Date.now()}`);
    }
    // add friend
    if (req.method === "POST" && url.pathname === "/friend") {
      const body = await req.json();
      const userId = body.id;
      const friendId = body.friendId;
      await addFriend(userId, friendId);
      await addFriend(friendId, userId);
      return new Response("ok");
    }
    // remove friend
    if (req.method === "DELETE" && url.pathname === "/friend") {
      const body = await req.json();
      const userId = body.id;
      const friendId = body.friendId;
      await removeFriend(userId, friendId);
      await removeFriend(friendId, userId);
      return new Response("ok");
    }
    // add user to room
    if (req.method === "POST" && url.pathname === "/room") {
      const body = await req.json();
      const userId = body.id;
      const roomId = body.roomId;
      await insertUserIntoRoom(userId, roomId);
      return new Response("ok");
    }
    // remove user from room
    if (req.method === "DELETE" && url.pathname === "/room") {
      const body = await req.json();
      const userId = body.id;
      const roomId = body.roomId;
      await removeUserFromRoom(userId, roomId);
      return new Response("ok");
    }
    //token create
    if (req.method === "POST" && url.pathname === "/signin") {
      const body = await req.json(); // id, name, avatar?
      // get user from db
      let user = await getUser(body?.id);
      console.log("[X]", user);
      if (!user) {
        // create user
        const userId = userIdGenerator();
        user = {
          id: userId,
          username: body.username,
          avatar: body?.avatar,
          rooms: [],
          friends: [],
          isBanned: false,
          lastSeen: Date.now(),
        };
        await saveUser(user);
      }

      const token = createToken({ id: user.id });
      return new Response(JSON.stringify({ user, token }), {
        headers: { "Content-Type": "application/json" },
      });
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
    } else {
      return new Response("Not found", { status: 404 });
    }
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
      } catch (err) {
        console.error("[ws open error]", ws.data.id, err);
      }
    },
    //message ws
    async message(ws, message: string) {
      try {
        // get user
        const user = await getUser(ws.data.id);
        if (!user) {
          return ws.close(4000, "Error: getting your info");
        }
        if (user.isBanned) {
          return ws.close(4001, "You are banned");
        }

        console.log("message from", ws.data.id, ":", message);
        // parse message
        const msg = JSON.parse(message) as WSMessage;
        // send message event
        if (msg.type === "message") {
          // save message
          const msgId = messageIdGenerator();
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
          await saveMessage(message);
          if (msg.context === "dm") {
            console.log("sending dm to", msg.to);
            ws.publish(
              `user:${msg.to}`,
              JSON.stringify({
                type: "message",
                id: message.id,
                from: message.from,
                content: message.content,
                date: message.date,
              })
            );
          } else {
            console.log("sending room message to", msg.to);
            ws.publish(
              `room:${msg.to}`,
              JSON.stringify({
                type: "message",
                id: message.id,
                from: message.from,
                content: message.content,
                date: message.date,
              })
            );
          }
        }
        // send typing event
        else if (msg.type === "action" && msg.action === "typing") {
          if (msg.context === "dm") {
            console.log("sending dm typing to", msg.to);
            ws.publish(
              `user:${msg.to}`,
              JSON.stringify({
                type: "typing",
                from: ws.data.id,
              })
            );
          } else {
            console.log("sending room typing to", msg.to);
            ws.publish(
              `room:${msg.to}`,
              JSON.stringify({
                type: "typing",
                from: ws.data.id,
              })
            );
          }
        }
        // message read event
        else if (msg.type === "action" && msg.action === "read") {
          // get message from field
          const from = await redis.json.get(`message:${msg.messageId}`, {
            path: "$.from",
          });
          if (!from) return;
          // update message
          await markMessageAsRead(msg.messageId);
          // send read event
          ws.publish(
            `user:${from}`,
            JSON.stringify({
              type: "message-read",
              by: ws.data.id,
              messageId: msg.messageId,
            })
          );
        }
        // ping event
        else {
          // update last seen
          await updateLastSeen(user.id);
          // brodcast ping to friends
          user.friends.forEach((friend) =>
            ws.publish(
              `user:${friend}`,
              JSON.stringify({
                type: "user-online",
              })
            )
          );
          // brodcast ping to rooms
          user.rooms.forEach((room) =>
            ws.publish(
              `room:${room}`,
              JSON.stringify({
                type: "user-online",
              })
            )
          );
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
