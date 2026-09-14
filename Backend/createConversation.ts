import { HandlerFn } from "./types.ts";
import {sql} from "./db.ts";

export const createConversation: HandlerFn = async (payload, ctx) => {
  if (!ctx.userId) {
    return { status: 401, body: { error: "Unauthorized: no user found on request" } };
  }

  const title = payload?.title;

  if (!title || typeof title !== "string" || !title.trim()) {
    return { status: 400, body: { error: "A non-empty 'title' string is required" } };
  }

 /*const { data, error } = await ctx.supabase
    .from("conversations")
    .insert({ user_id: ctx.userId, title: title.trim() })
    .select("id, title, created_at")
    .single();

  if (error) {
    console.error("createConversation error:", error);
    return { status: 500, body: { error: "Failed to create conversation" } };
  }

  return { status: 201, body: { conversation: data } };*/
  try {
    const [data] = await sql`
    INSERT INTO conversations (user_id, title)
    VALUES (${ctx.userId}, ${title.trim()})
    RETURNING id::text, title, created_at
    `;
    return { status: 201, body: { conversation: data } };
  } catch (error) {
    console.error("createConversation error:", error);
    return { status: 500, body: { error: "Failed to create conversation" } };
  }
};
