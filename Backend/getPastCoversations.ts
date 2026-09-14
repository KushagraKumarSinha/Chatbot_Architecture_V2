import { HandlerFn } from "./types.ts";
import {sql} from "./db.ts"

export const getPastConversations: HandlerFn = async (payload, ctx) => {
  if (!ctx.userId) {
    return { status: 401, body: { error: "Unauthorized: no user found on request" } };
  }

  const conversationId = payload?.conversation_id;

  if (!conversationId || typeof conversationId !== "string") {
    return { status: 400, body: { error: "A valid 'conversation_id' is required" } };
  }

  // Verify the conversation belongs to this user before returning its messages
  /*const { data: conversation, error: convError } = await ctx.supabase
    .from("conversations")
    .select("id, title")
    .eq("id", conversationId)
    .eq("user_id", ctx.userId)
    .single();

  if (convError || !conversation) {
    return { status: 404, body: { error: "Conversation not found" } };
  }

  const { data: messages, error: messagesError } = await ctx.supabase
    .from("messages")
    .select("id, messages, by, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (messagesError) {
    console.error("getPastConversations error:", messagesError);
    return { status: 500, body: { error: "Failed to fetch messages" } };
  }

  // Reverse so the response is oldest -> newest (natural reading order)
  const orderedMessages = (messages ?? []).reverse();

  return {
    status: 200,
    body: {
      conversation: { id: conversation.id, title: conversation.title },
      messages: orderedMessages,
    },
  };*/
  const [conversation] = await sql`
    SELECT id, title
    FROM conversations
    WHERE id = ${conversationId} AND user_id = ${ctx.userId}
  `;

  if (!conversation) {
    return { status: 404, body: { error: "Conversation not found" } };
  }

  try {
    const messages = await sql`
      SELECT id, messages, by, created_at
      FROM messages
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at DESC
      LIMIT 20
    `;

    const orderedMessages = (messages ?? []).reverse();
    return { status: 200, body: { messages: orderedMessages } };
  } catch (error) {
    console.error("getPastConversations error:", error);
    return { status: 500, body: { error: "Failed to fetch messages" } };
  }
};
