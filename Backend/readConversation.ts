import { HandlerFn } from "./types.ts";
import {sql} from "./db.ts"

export const readConversation: HandlerFn = async (payload, ctx) => {
  if (!ctx.userId) {
    return { status: 401, body: { error: "Unauthorized: no user found on request" } };
  }

  /*const { data, error } = await ctx.supabase
    .from("conversations")
    .select("id, title, created_at")
    .eq("user_id", ctx.userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("readConversation error:", error);
    return { status: 500, body: { error: "Failed to fetch conversations" } };
  }
  return { status: 200, body: { conversations: data } };*/
  try {
    const data = await sql`
      SELECT id, title, created_at
      FROM conversations
      WHERE user_id = ${ctx.userId}
      ORDER BY created_at DESC
    `;
    return { status: 200, body: { conversations: data } };
  } catch (error) {
    console.error("readConversation error:", error);
    return { status: 500, body: { error: "Failed to fetch conversations" } };
  }
};
