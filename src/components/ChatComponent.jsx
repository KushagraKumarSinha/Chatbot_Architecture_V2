import { useLocation } from 'react-router-dom';
import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../SupabaseClient';
import { useAuth } from '../AuthContext';
import { useNavigate } from "react-router-dom";
import { Sparkles, ImagePlus, Type, Pencil, MessageSquare, Send } from "lucide-react";
import { chatwithLLM, getPastMessages} from '../apicalls/conversationapis';

const renderInline = (text) => {
  const parts = text.split(/(\*\*.*?\*\*|\*.*?\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={idx}>{part.slice(1, -1)}</em>;
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
};

const renderMessage = (message) => {
  if (!message) return null;
  // Split on blank lines / newlines so each paragraph gets its own <p>,
  // matching the paragraph spacing seen in the reference screenshot.
  const paragraphs = message.split(/\n+/).filter(Boolean);
  return paragraphs.map((para, i) => (
    <p key={i} className={i > 0 ? "mt-3" : ""}>
      {renderInline(para)}
    </p>
  ));
};

const TypingIndicator = () => (
  <div className="inline-flex items-center gap-1 bg-slate-100 rounded-2xl px-4 py-3">
    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:-0.3s]" />
    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:-0.15s]" />
    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" />
  </div>
);

const ChatComponent = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState(() => location.state?.messages || []);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState(null);
  const title = location.state?.title || "";
  const conversationID = location.state?.conversationID || "";
  const { session, loading: authLoading, signInWithOtp, signOut } = useAuth();
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSending]);

  // Auto-dismiss the error toast after a few seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const data = await getPastMessages(conversationID);
        const normalized = data.messages.map((m) => ({
          ...m,
          message: m.messages,
        }));
        setMessages(normalized);
      } catch (err) {
        console.error("Error", err.message);
      }
    };
    fetchData();
  }, []);

  const handleSendMessage = async (e) => {
    e.preventDefault();
    const userMessage = input.trim();
    if (!userMessage || isSending) return;

    // Optimistically show the user's message right away
    setMessages((prev) => [
      ...prev,
      {
        id: `temp-user-${Date.now()}`,
        by: "user",
        message: userMessage,
      },
    ]);
    setInput("");
    setIsSending(true);
    setError(null);

    try {
      const data = await chatwithLLM(conversationID, userMessage);
      const reply = data?.reply;

      if (reply?.messages) {
        setMessages((prev) => [
          ...prev,
          {
            id: reply.id ?? `temp-bot-${Date.now()}`,
            by: reply.by ?? "bot",
            message: reply.messages,
            created_at: reply.created_at,
          },
        ]);
      } else {
        console.warn("Unexpected chatwithLLM response shape:", data);
        setError("Something went wrong. Please try again.");
      }
    } catch (err) {
      console.error("Failed to send message:", err.message);
      setError("Failed to send message. Please try again.");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-white text-slate-800">
      {/* Error Toast */}
      {error && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50">
          <div className="flex items-center gap-3 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl shadow-lg">
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-600 font-medium"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Chat Message Window */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((msg, i) => (
            <div
              key={msg.id ?? i}
              className={`flex ${msg.by === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.by === 'user' ? (
                <div className="max-w-[75%] px-4 py-3 rounded-2xl rounded-br-md bg-slate-900 text-white text-sm leading-relaxed">
                  {msg.message}
                </div>
              ) : (
                <div className="max-w-[80%] px-5 py-4 rounded-2xl bg-slate-50 text-slate-800 text-sm leading-relaxed">
                  {renderMessage(msg.message)}
                </div>
              )}
            </div>
          ))}

          {isSending && (
            <div className="flex justify-start">
              <TypingIndicator />
            </div>
          )}

          <div ref={scrollRef} />
        </div>
      </div>

      {/* Input Dock Area */}
      <div className="px-8 pb-6 pt-3 border-t border-slate-100 shrink-0">
        <div className="max-w-3xl mx-auto">
          <form onSubmit={handleSendMessage} className="flex items-center gap-3">
            <div className="flex-1 flex flex-col bg-white border border-slate-200 rounded-2xl px-4 py-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Message the assistant..."
                className="bg-transparent border-0 outline-none text-sm text-slate-800 placeholder-slate-400 py-1.5"
              />
              <div className="flex items-center gap-1 pt-1">
                <button type="button" className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors">
                  <ImagePlus size={16} strokeWidth={2} />
                </button>
                <button type="button" className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors">
                  <Type size={16} strokeWidth={2} />
                </button>
                <button type="button" className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors">
                  <Pencil size={16} strokeWidth={2} />
                </button>
                <button type="button" className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors">
                  <MessageSquare size={16} strokeWidth={2} />
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={isSending}
              className="p-3.5 bg-slate-500 hover:bg-slate-700 disabled:opacity-50 text-white rounded-full transition-colors shrink-0"
            >
              <Send size={16} strokeWidth={2} />
            </button>
          </form>
        </div>
      </div>

    </div>
  );
};

export default ChatComponent;