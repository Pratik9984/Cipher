"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

type Chat = { type: "user" | "group"; id: string | number; name: string };
type Contact = {
  phone_number: string;
  display_name?: string | null;
  nickname?: string | null;
  is_online?: boolean;
};
type Group = { id: string | number; name: string; members: string[] };
type Message = {
  id: string | number;
  user: string;
  content: string;
  timestamp: string;
  group_id?: string | number;
  group_name?: string;
  receiver_phone?: string;
  target_user?: string;
  is_read?: boolean;
  is_deleted?: boolean;
  edited_at?: string;
};
type GroupedMessage = ({ type: "divider"; label: string } | ({ type: "msg" } & Message));
type CallState = "idle" | "incoming" | "calling" | "connected";
type ApiOptions = RequestInit & { headers?: HeadersInit };

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Request failed";

const API = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
const WS = process.env.NEXT_PUBLIC_WS_URL || API.replace(/^http/, "ws");

const MEDIA_PREFIXES = ["[IMAGE]", "[AUDIO]", "[VIDEO]", "[PDF]", "[FILE]"] as const;
const isMediaMessage = (content: string) => MEDIA_PREFIXES.some(p => content.startsWith(p));

// Detect and linkify URLs in plain text
function renderText(content: string, isMine: boolean) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = content.split(urlRegex);
  return parts.map((part, i) =>
    urlRegex.test(part)
      ? <a key={i} href={part} target="_blank" rel="noreferrer" className={`msg-link ${isMine ? "msg-link--mine" : ""}`}>{part}</a>
      : <React.Fragment key={i}>{part}</React.Fragment>
  );
}

export default function CipherChat() {
  // ─── State ──────────────────────────────────────────────────────────────────
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => setIsMounted(true), []);

  const [phoneNumber, setPhoneNumber] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [token, setToken] = useState(() => (typeof window === "undefined" ? "" : localStorage.getItem("chat_token") || ""));
  const [currentUser, setCurrentUser] = useState(() => (typeof window === "undefined" ? "" : localStorage.getItem("chat_user") || ""));
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const isAuth = !!token;

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMsg, setInputMsg] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unread, setUnread] = useState<Record<string, number>>({});

  const [editingId, setEditingId] = useState<string | number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [typingSet, setTypingSet] = useState<Set<string>>(new Set());

  const [showEmojis, setShowEmojis] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showNewContact, setShowNewContact] = useState(false);
  const [newContactPhone, setNewContactPhone] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [newGroupMembers, setNewGroupMembers] = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");

  // FIX: File viewer modal state
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const [viewerType, setViewerType] = useState<"image" | "video" | "pdf" | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [callState, setCallState] = useState<CallState>("idle");
  const [isVideoCall, setIsVideoCall] = useState(false);
  const [callPeer, setCallPeer] = useState<string | null>(null);

  // ─── Refs ───────────────────────────────────────────────────────────────────
  const msgListRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const wsRetryDelay = useRef(1000);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const pendingRemoteDescriptionRef = useRef<RTCSessionDescriptionInit | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const messagesCache = useRef<Record<string, Message[]>>({});

  const emojis = ["😀","😂","🥰","😎","🤔","😭","😡","👍","❤️","🔥","🎉","🚀","✅","💯","🙏","🫡","😤","🤩","💀","🫶","😏","🥺","😴","🤣","😊","🤯","💪","🤝","👏","✨"];
  const PAGE = 50;

  const isTyping = useMemo(() => activeChat?.type === "user" && typingSet.has(String(activeChat.id)), [activeChat, typingSet]);

  // ─── API Helper ─────────────────────────────────────────────────────────────
  const apiFetch = useCallback(async <T,>(path: string, opts: ApiOptions = {}): Promise<T> => {
    const headers = new Headers(opts.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    headers.set("ngrok-skip-browser-warning", "true");
    const currentToken = token || (typeof window !== "undefined" ? localStorage.getItem("chat_token") : "");
    if (currentToken) headers.set("Authorization", `Bearer ${currentToken}`);
    const res = await fetch(`${API}${path}`, { ...opts, headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: "Request failed" }));
      throw new Error(body.detail || "Request failed");
    }
    return res.json();
  }, [token]);

  // ─── Data Loaders ───────────────────────────────────────────────────────────
  const loadContacts = useCallback(async () => {
    try { setContacts(await apiFetch<Contact[]>("/contacts")); } catch { }
  }, [apiFetch]);

  const loadGroups = useCallback(async () => {
    try { setGroups(await apiFetch<Group[]>("/groups")); } catch { }
  }, [apiFetch]);

  const scrollBottom = (smooth = false) => {
    if (msgListRef.current) {
      msgListRef.current.scrollTo({ top: msgListRef.current.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    }
  };

  const loadHistory = async (chat: Chat, beforeId: string | number | null = null) => {
    if (!chat) return;
    setLoadingMore(true);
    try {
      const { type, id } = chat;
      const base = type === "user" ? `/messages/direct/${encodeURIComponent(id)}` : `/messages/group/${id}`;
      const history = await apiFetch<Message[]>(base + (beforeId ? `?before_id=${beforeId}` : ""));

      if (beforeId) {
        setMessages(prev => {
          const next = [...history, ...prev];
          messagesCache.current[chat.id] = next;
          return next;
        });
      } else {
        setMessages(history);
        messagesCache.current[chat.id] = history;
        setTimeout(() => scrollBottom(), 100);
      }
      setHasMore(history.length === PAGE);
    } catch { }
    setLoadingMore(false);
  };

  // ─── WebSocket Logic ────────────────────────────────────────────────────────
  const notify = (title: string, body: string) => {
    if (typeof window === "undefined" || Notification.permission !== "granted" || document.hasFocus()) return;
    const n = new Notification(title, { body });
    setTimeout(() => n.close(), 5000);
  };

  const endCall = useCallback((sendSignal = true) => {
    if (sendSignal && callPeer && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "call_end", target_user: callPeer }));
    }
    if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
    if (peerConnectionRef.current) peerConnectionRef.current.close();
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    peerConnectionRef.current = null;
    pendingRemoteDescriptionRef.current = null;
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    setCallState("idle");
    setCallPeer(null);
  }, [callPeer]);

  const initWSRef = useRef<(() => void) | null>(null);

  const initWS = useCallback(() => {
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    if (!token) return;

    const ws = new WebSocket(`${WS}/ws?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;

    ws.onopen = () => { wsRetryDelay.current = 1000; };
    ws.onclose = () => {
      if (!token) return;
      setTimeout(() => {
        wsRetryDelay.current = Math.min(wsRetryDelay.current * 2, 30000);
        initWSRef.current?.();
      }, wsRetryDelay.current);
    };

    ws.onmessage = async ({ data: raw }) => {
      let data: Partial<Message> & Record<string, unknown>;
      try { data = JSON.parse(raw); } catch { return; }

      switch (data.type) {
        case "typing":
          if (typeof data.user === "string" && data.user !== currentUser) {
            setTypingSet(prev => new Set(prev).add(data.user as string));
            setTimeout(() => {
              setTypingSet(prev => { const next = new Set(prev); next.delete(data.user as string); return next; });
            }, 2000);
          }
          break;

        case "direct_message": {
          setTypingSet(prev => { const next = new Set(prev); next.delete(String(data.user)); return next; });
          const peer = data.user === currentUser ? (data.receiver_phone || data.target_user) : data.user;
          if (!peer) break;
          const msg = data as Message;

          setContacts(prev => prev.find(c => c.phone_number === peer) ? prev : [...prev, { phone_number: String(peer), display_name: null, is_online: false }]);

          setActiveChat(currentActive => {
            if (currentActive?.type === "user" && currentActive.id === peer) {
              setMessages(prev => {
                let next = prev;
                if (data.user === currentUser) {
                  const idx = prev.findIndex(m => String(m.id).startsWith("temp-") && m.content === msg.content);
                  if (idx !== -1) {
                    next = [...prev]; next[idx] = msg;
                  } else if (!prev.find(m => m.id === msg.id)) {
                    next = [...prev, msg];
                  }
                } else if (!prev.find(m => m.id === msg.id)) {
                  next = [...prev, msg];
                }
                messagesCache.current[peer] = next;
                return next;
              });
              setTimeout(() => scrollBottom(true), 50);
              if (data.user !== currentUser && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "read_receipt", target_user: peer }));
              }
            } else if (data.user !== currentUser) {
              setUnread(prev => ({ ...prev, [String(peer)]: (prev[String(peer)] || 0) + 1 }));
              notify(String(data.user), msg.content);
            }
            return currentActive;
          });
          break;
        }

        case "group_message": {
          setActiveChat(currentActive => {
            if (currentActive?.type === "group" && currentActive.id === data.group_id) {
              setMessages(prev => {
                let next = prev;
                const msg = data as Message;
                if (data.user === currentUser) {
                  const idx = prev.findIndex(m => String(m.id).startsWith("temp-") && m.content === msg.content);
                  if (idx !== -1) {
                    next = [...prev]; next[idx] = msg;
                  } else if (!prev.find(m => m.id === msg.id)) {
                    next = [...prev, msg];
                  }
                } else if (!prev.find(m => m.id === msg.id)) {
                  next = [...prev, msg];
                }
                messagesCache.current[data.group_id as string | number] = next;
                return next;
              });
              setTimeout(() => scrollBottom(true), 50);
            } else if (data.user !== currentUser) {
              setUnread(prev => ({ ...prev, [String(data.group_id)]: (prev[String(data.group_id)] || 0) + 1 }));
              notify(`${data.group_name}`, `${data.user}: ${data.content}`);
            }
            return currentActive;
          });
          break;
        }

        case "read_receipt":
          setMessages(prev => prev.map(m => m.user === currentUser ? { ...m, is_read: true } : m));
          break;

        case "message_edited": {
          setMessages(prev => prev.map(m => m.id === data.id ? { ...m, content: String(data.content || ""), edited_at: data.edited_at } : m));
          break;
        }

        case "message_deleted":
          setMessages(prev => prev.map(m => m.id === data.id ? { ...m, is_deleted: true } : m));
          break;

        case "presence":
          setContacts(prev => prev.map(c => c.phone_number === data.user ? { ...c, is_online: Boolean(data.online) } : c));
          break;

        // WebRTC Events
        case "call_offer":
          setCallPeer(String(data.user || ""));
          setIsVideoCall(Boolean(data.isVideo));
          setCallState("incoming");
          pendingRemoteDescriptionRef.current = data.sdp as RTCSessionDescriptionInit;
          break;

        case "call_answer":
          if (peerConnectionRef.current) {
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.sdp as RTCSessionDescriptionInit));
            setCallState("connected");
          }
          break;

        case "ice_candidate":
          // FIX: was incorrectly checking `?.setRemoteDescription` property
          if (peerConnectionRef.current) {
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate as RTCIceCandidateInit));
          }
          break;

        case "call_end":
        case "call_reject":
          endCall(false);
          break;
      }
    };
  }, [token, currentUser, endCall]);

  useEffect(() => { initWSRef.current = initWS; }, [initWS]);

  useEffect(() => {
    if (token) {
      (async () => {
        await Promise.all([loadContacts(), loadGroups()]);
        initWS();
      })();
    }
    return () => {
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    };
  }, [token, loadContacts, loadGroups, initWS]);

  // ─── Authentication ─────────────────────────────────────────────────────────
  const sendOTP = async () => {
    setAuthError(""); setAuthLoading(true);
    try {
      await apiFetch<void>("/auth/send-otp", { method: "POST", body: JSON.stringify({ phone_number: phoneNumber.trim() }) });
      setOtpSent(true);
    } catch (e) { setAuthError(errorMessage(e)); }
    finally { setAuthLoading(false); }
  };

  const verifyOTP = async () => {
    setAuthError(""); setAuthLoading(true);
    try {
      const data = await apiFetch<{ access_token: string }>("/auth/verify-otp", {
        method: "POST",
        body: JSON.stringify({ phone_number: phoneNumber.trim(), otp: otp.trim() })
      });
      setToken(data.access_token);
      setCurrentUser(phoneNumber.trim());
      localStorage.setItem("chat_token", data.access_token);
      localStorage.setItem("chat_user", phoneNumber.trim());
      if ("Notification" in window) Notification.requestPermission();
    } catch (e) { setAuthError(errorMessage(e)); }
    finally { setAuthLoading(false); }
  };

  const logout = () => {
    setToken(""); setCurrentUser(""); setOtpSent(false);
    setMessages([]); setActiveChat(null); setContacts([]); setGroups([]); setUnread({});
    localStorage.removeItem("chat_token"); localStorage.removeItem("chat_user");
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
  };

  // ─── Actions ─────────────────────────────────────────────────────────────────
  const openChat = async (chat: Chat) => {
    setActiveChat(chat);
    if (messagesCache.current[chat.id]) {
      setMessages(messagesCache.current[chat.id]);
      setTimeout(() => scrollBottom(), 10);
    } else {
      setMessages([]);
    }
    setHasMore(false);
    setShowEmojis(false);
    setEditingId(null);
    setUnread(prev => ({ ...prev, [chat.id]: 0 }));
    await loadHistory(chat);
  };

  const sendMessage = async () => {
    const text = inputMsg.trim();
    if (!text || !activeChat || wsRef.current?.readyState !== WebSocket.OPEN) return;
    setInputMsg(""); setShowEmojis(false);

    const { type, id } = activeChat;
    const optimisticMsg: Message = {
      id: `temp-${Date.now()}-${Math.random()}`,
      user: currentUser,
      content: text,
      timestamp: new Date().toISOString(),
      ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name })
    };

    setMessages(prev => {
      const next = [...prev, optimisticMsg];
      messagesCache.current[id] = next;
      return next;
    });
    setTimeout(() => scrollBottom(true), 50);

    wsRef.current.send(JSON.stringify(type === "user"
      ? { type: "direct_message", target_user: id, content: text, message_type: "text" }
      : { type: "group_message", group_id: id, content: text, message_type: "text" }));
  };

  const saveEdit = async () => {
    if (!editingId || !activeChat) return;
    try {
      await apiFetch<void>(`/messages/${editingId}`, { method: "PATCH", body: JSON.stringify({ content: editingText }) });
      setMessages(prev => prev.map(m => m.id === editingId ? { ...m, content: editingText, edited_at: new Date().toISOString() } : m));
      setEditingId(null); setEditingText("");
    } catch { }
  };

  const deleteMsg = async (id: string | number) => {
    try {
      await apiFetch<void>(`/messages/${id}`, { method: "DELETE" });
      setMessages(prev => prev.map(m => m.id === id ? { ...m, is_deleted: true } : m));
    } catch { }
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputMsg(e.target.value);
    if (wsRef.current?.readyState === WebSocket.OPEN && activeChat?.type === "user") {
      wsRef.current.send(JSON.stringify({ type: "typing", target_user: activeChat.id }));
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeChat) return;
    const form = new FormData(); form.append("file", file);
    try {
      const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      if (!res.ok) { alert("Upload failed"); return; }
      const data = await res.json();

      const isImg = data.content_type?.startsWith("image");
      const isAud = data.content_type?.startsWith("audio");
      const isVid = data.content_type?.startsWith("video");
      const isPdf = data.content_type === "application/pdf";

      const tag = isImg ? `[IMAGE]${data.url}` : isAud ? `[AUDIO]${data.url}` : isVid ? `[VIDEO]${data.url}` : isPdf ? `[PDF]${data.url}` : `[FILE]${data.url}`;
      const msgType = isImg ? "image" : isAud ? "audio" : isVid ? "video" : isPdf ? "pdf" : "file";
      const { type, id } = activeChat;

      const optimisticMsg: Message = {
        id: `temp-${Date.now()}-${Math.random()}`,
        user: currentUser, content: tag, timestamp: new Date().toISOString(),
        ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name })
      };
      setMessages(prev => { const next = [...prev, optimisticMsg]; messagesCache.current[id] = next; return next; });
      setTimeout(() => scrollBottom(true), 50);

      wsRef.current?.send(JSON.stringify(type === "user"
        ? { type: "direct_message", target_user: id, content: tag, message_type: msgType }
        : { type: "group_message", group_id: id, content: tag, message_type: msgType }));
    } catch { }
    e.target.value = "";
  };

  const toggleRecording = async () => {
    if (!activeChat) return;
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      mediaRecorderRef.current?.stream.getTracks().forEach(t => t.stop());
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = e => audioChunksRef.current.push(e.data);
      mr.onstop = async () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const form = new FormData(); form.append("file", blob, "voice.webm");
        const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
        const data = await res.json();
        const tag = `[AUDIO]${data.url}`;
        const { type, id } = activeChat;
        const optimisticMsg: Message = {
          id: `temp-${Date.now()}-${Math.random()}`,
          user: currentUser, content: tag, timestamp: new Date().toISOString(),
          ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name })
        };
        setMessages(prev => { const next = [...prev, optimisticMsg]; messagesCache.current[id] = next; return next; });
        setTimeout(() => scrollBottom(true), 50);
        wsRef.current?.send(JSON.stringify(type === "user"
          ? { type: "direct_message", target_user: id, content: tag, message_type: "audio" }
          : { type: "group_message", group_id: id, content: tag, message_type: "audio" }));
      };
      mr.start(); setIsRecording(true);
    } catch { }
  };

  // ─── WebRTC ──────────────────────────────────────────────────────────────────
  const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] };

  const setupWebRTC = async (targetUser: string) => {
    const localStream = localStreamRef.current;
    if (!localStream) throw new Error("Local media stream is not available");

    const peerConnection = new RTCPeerConnection(rtcConfig);
    peerConnectionRef.current = peerConnection;
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (event) => {
      remoteStreamRef.current = event.streams[0];
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStreamRef.current;
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ice_candidate", target_user: targetUser, candidate: event.candidate }));
      }
    };
  };

  const startCall = async (video = true) => {
    if (!activeChat || activeChat.type !== "user") return;
    const target = String(activeChat.id);
    try {
      setIsVideoCall(video); setCallState("calling"); setCallPeer(target);
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ video, audio: true });
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;

      await setupWebRTC(target);
      const peerConnection = peerConnectionRef.current;
      const ws = wsRef.current;
      if (!peerConnection || ws?.readyState !== WebSocket.OPEN) throw new Error("Not ready");
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: "call_offer", target_user: target, sdp: offer, isVideo: video }));
    } catch {
      alert("Could not access camera/microphone");
      endCall(false);
    }
  };

  const acceptCall = async () => {
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: isVideoCall, audio: true });
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
      if (!callPeer || !pendingRemoteDescriptionRef.current) throw new Error("No offer");
      await setupWebRTC(callPeer);

      const peerConnection = peerConnectionRef.current;
      const ws = wsRef.current;
      if (!peerConnection || ws?.readyState !== WebSocket.OPEN) throw new Error("Not ready");
      await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingRemoteDescriptionRef.current));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: "call_answer", target_user: callPeer, sdp: answer }));
      setCallState("connected");
    } catch { rejectCall(); }
  };

  const rejectCall = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "call_reject", target_user: callPeer }));
    }
    endCall(false);
  };

  // ─── Formatters ─────────────────────────────────────────────────────────────
  const formatTime = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const formatDate = (ts: string) => {
    const d = new Date(ts); const today = new Date();
    if (d.toDateString() === today.toDateString()) return "Today";
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  };

  const groupedMessages = useMemo(() => {
    const out: GroupedMessage[] = []; let lastDate: string | null = null;
    for (const msg of messages) {
      const label = formatDate(msg.timestamp);
      if (label !== lastDate) { out.push({ type: "divider", label }); lastDate = label; }
      out.push({ type: "msg", ...msg });
    }
    return out;
  }, [messages]);

  // ─── Render Bubble Content ───────────────────────────────────────────────────
  const renderBubbleContent = (item: Message) => {
    const { content } = item;
    const isMine = item.user === currentUser;

    if (content.startsWith("[IMAGE]")) {
      const src = content.replace("[IMAGE]", "");
      return (
        <button className="msg-media-btn" onClick={() => { setViewerSrc(src); setViewerType("image"); }}>
          <img src={src} alt="attachment" className="msg-img" />
          <div className="msg-media-overlay"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 19a10.94 10.94 0 0 1-1.72-1.49M13.99 5.08A10.93 10.93 0 0 1 12 5c-7 0-11 8-11 8a18.27 18.27 0 0 0 5.06 5.94"/></svg>View</div>
        </button>
      );
    }
    if (content.startsWith("[AUDIO]")) {
      return <audio src={content.replace("[AUDIO]", "")} controls className="msg-audio" />;
    }
    if (content.startsWith("[VIDEO]")) {
      const src = content.replace("[VIDEO]", "");
      return (
        <button className="msg-media-btn" onClick={() => { setViewerSrc(src); setViewerType("video"); }}>
          <video src={src} className="msg-video-thumb" />
          <div className="msg-play-btn"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
        </button>
      );
    }
    if (content.startsWith("[PDF]")) {
      const src = content.replace("[PDF]", "");
      return (
        <button className="msg-file-box" onClick={() => { setViewerSrc(src); setViewerType("pdf"); }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span>View PDF</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
      );
    }
    if (content.startsWith("[FILE]")) {
      const src = content.replace("[FILE]", "");
      const name = src.split("/").pop() || "file";
      return (
        <a href={src} target="_blank" rel="noreferrer" className="msg-file-box">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>{name}</span>
        </a>
      );
    }
    return <span className="msg-text">{renderText(content, isMine)}</span>;
  };

  if (!isMounted) return (
    <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="boot-loader">
        <div className="boot-logo">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <path d="M4 8C4 5.79 5.79 4 8 4H20C22.21 4 24 5.79 24 8V16C24 18.21 22.21 20 20 20H15L9 24V20H8C5.79 20 4 18.21 4 16V8Z" fill="currentColor"/>
          </svg>
        </div>
        <div className="boot-dots"><span></span><span></span><span></span></div>
      </div>
    </div>
  );

  // ─── RENDER ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {/* Animated background orbs */}
      <div className="bg-orb bg-orb-1"></div>
      <div className="bg-orb bg-orb-2"></div>
      <div className="bg-orb bg-orb-3"></div>

      {!isAuth ? (
        /* ── Auth Screen ── */
        <div className="auth-screen">
          <div className="auth-left">
            <div className="brand">
              <div className="brand-icon">
                <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
                  <path d="M4 8C4 5.79 5.79 4 8 4H20C22.21 4 24 5.79 24 8V16C24 18.21 22.21 20 20 20H15L9 24V20H8C5.79 20 4 18.21 4 16V8Z" fill="currentColor"/>
                  <circle cx="10" cy="12" r="1.5" fill="rgba(0,0,0,0.45)"/>
                  <circle cx="14" cy="12" r="1.5" fill="rgba(0,0,0,0.45)"/>
                  <circle cx="18" cy="12" r="1.5" fill="rgba(0,0,0,0.45)"/>
                </svg>
              </div>
              <span className="brand-name">Cipher</span>
            </div>
            <div className="auth-hero">
              <h1>Connect.<br/>Fast.<br/><em>Beautifully.</em></h1>
              <p>Real-time messaging built for speed, reliability, and delight.</p>
            </div>
            <div className="auth-features">
              <div className="auth-feat"><div className="feat-icon feat-icon--gold">⚡</div><div><strong>Instant</strong><span>Sub-millisecond delivery</span></div></div>
              <div className="auth-feat"><div className="feat-icon feat-icon--purple">💬</div><div><strong>Real-time</strong><span>Live typing & presence</span></div></div>
              <div className="auth-feat"><div className="feat-icon feat-icon--green">📞</div><div><strong>Voice & Video</strong><span>WebRTC powered calls</span></div></div>
            </div>
          </div>

          <div className="auth-right">
            <div className="auth-card">
              <div className="auth-card-glow"></div>
              {!otpSent ? (
                <>
                  <h2 className="ac-title">Welcome back</h2>
                  <p className="ac-sub">Enter your phone number to continue</p>
                  <div className="ac-field">
                    <label>Phone number</label>
                    <div className="ac-input-wrap">
                      <svg className="ac-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z"/></svg>
                      <input value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} onKeyDown={e => e.key === "Enter" && sendOTP()} type="tel" placeholder="+91 98765 43210" className="ac-input"/>
                    </div>
                  </div>
                  <button disabled={authLoading || !phoneNumber.trim()} onClick={sendOTP} className="ac-btn">
                    {authLoading ? <><span className="spinner"></span>Sending…</> : <>Get verification code <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg></>}
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => setOtpSent(false)} className="ac-back">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg> Back
                  </button>
                  <h2 className="ac-title">Enter code</h2>
                  <p className="ac-sub">6-digit code sent to <strong>{phoneNumber}</strong></p>
                  <div className="ac-field">
                    <label>Verification code</label>
                    <input value={otp} onChange={e => setOtp(e.target.value)} onKeyDown={e => e.key === "Enter" && verifyOTP()} type="text" inputMode="numeric" placeholder="000000" maxLength={6} className="ac-input ac-otp"/>
                  </div>
                  <button disabled={authLoading || otp.length < 6} onClick={verifyOTP} className="ac-btn">
                    {authLoading ? <><span className="spinner"></span>Verifying…</> : <>Verify & sign in <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg></>}
                  </button>
                </>
              )}
              {authError && (
                <div className="ac-error">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  {authError}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className={`shell ${activeChat ? "chat-active" : ""}`}>
          {/* ── Sidebar ── */}
          <aside className="sidebar">
            <div className="sb-top">
              <div className="sb-identity">
                <div className="sb-id-avatar">{(currentUser[0] || "?").toUpperCase()}</div>
                <div className="sb-id-info">
                  <span className="sb-id-name">{currentUser}</span>
                  <span className="sb-id-status"><span className="status-dot status-dot--on"></span>Online</span>
                </div>
                <button onClick={logout} className="logout-icon-btn" title="Sign out">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
                </button>
              </div>

              <div className="sb-profile-toggle" onClick={() => setShowProfile(!showProfile)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                Edit Profile
                <svg className={`chevron ${showProfile ? "chevron--up" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6,9 12,15 18,9"/></svg>
              </div>

              {showProfile && (
                <div className="sb-profile-form drop">
                  <input value={editDisplayName} onChange={e => setEditDisplayName(e.target.value)} placeholder="Display name…" className="sb-field"/>
                  <button onClick={async () => { await apiFetch("/profile/me", { method: "PATCH", body: JSON.stringify({ display_name: editDisplayName }) }); setShowProfile(false); }} className="sb-save-btn">Save changes</button>
                </div>
              )}
            </div>

            <div className="sb-scroll">
              {/* Direct Messages */}
              <div className="sb-section">
                <div className="sb-section-hdr">
                  <div className="sb-section-label">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                    Messages
                    {contacts.length > 0 && <span className="section-count">{contacts.length}</span>}
                  </div>
                  <button onClick={() => setShowNewContact(!showNewContact)} className={`sb-add-btn ${showNewContact ? "active" : ""}`} title="New chat">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  </button>
                </div>

                {showNewContact && (
                  <div className="sb-add-form drop">
                    <input value={newContactPhone} onChange={e => setNewContactPhone(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && newContactPhone.trim()) { apiFetch("/contacts", { method: "POST", body: JSON.stringify({ contact_phone: newContactPhone.trim() }) }).then(() => { loadContacts(); openChat({ type: "user", id: newContactPhone.trim(), name: newContactPhone.trim() }); setNewContactPhone(""); setShowNewContact(false); }); } }}
                      placeholder="+91 phone number…" className="sb-field" autoFocus/>
                    <button onClick={() => { if (!newContactPhone.trim()) return; apiFetch("/contacts", { method: "POST", body: JSON.stringify({ contact_phone: newContactPhone.trim() }) }).then(() => { loadContacts(); openChat({ type: "user", id: newContactPhone.trim(), name: newContactPhone.trim() }); setNewContactPhone(""); setShowNewContact(false); }); }} className="sb-go-btn">Start chat →</button>
                  </div>
                )}

                <div className="sb-list">
                  {contacts.length === 0 && <div className="sb-empty">No contacts yet</div>}
                  {contacts.map(c => (
                    <button key={c.phone_number} onClick={() => openChat({ type: "user", id: c.phone_number, name: c.nickname || c.display_name || c.phone_number })} className={`sb-item ${activeChat?.id === c.phone_number ? "sb-item--active" : ""}`}>
                      <div className="sb-av">
                        {(c.display_name || c.phone_number)[0].toUpperCase()}
                        <span className={`pres ${c.is_online ? "pres--on" : ""}`}></span>
                      </div>
                      <div className="sb-item-body">
                        <span className="sb-item-name">{c.nickname || c.display_name || c.phone_number}</span>
                        <span className={`sb-item-sub ${c.is_online ? "online" : ""}`}>{c.is_online ? "● Online" : "○ Offline"}</span>
                      </div>
                      {unread[c.phone_number] > 0 && <span className="unread">{unread[c.phone_number]}</span>}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sb-divider"></div>

              {/* Groups */}
              <div className="sb-section">
                <div className="sb-section-hdr">
                  <div className="sb-section-label">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
                    Groups
                    {groups.length > 0 && <span className="section-count">{groups.length}</span>}
                  </div>
                  <button onClick={() => setShowNewGroup(!showNewGroup)} className={`sb-add-btn ${showNewGroup ? "active" : ""}`} title="New group">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  </button>
                </div>

                {showNewGroup && (
                  <div className="sb-add-form drop">
                    <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} placeholder="Group name *" className="sb-field"/>
                    <input value={newGroupMembers} onChange={e => setNewGroupMembers(e.target.value)} placeholder="Members (comma-separated) *" className="sb-field"/>
                    <input value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)} placeholder="Description (optional)" className="sb-field"/>
                    <button onClick={() => {
                      const members = newGroupMembers.trim().split(",").map(s => s.trim()).filter(Boolean);
                      if (!newGroupName.trim() || !members.length) return;
                      apiFetch("/groups", { method: "POST", body: JSON.stringify({ name: newGroupName.trim(), description: newGroupDesc, members }) })
                        .then(() => { setNewGroupName(""); setNewGroupDesc(""); setNewGroupMembers(""); setShowNewGroup(false); loadGroups(); });
                    }} className="sb-go-btn purple">Create group →</button>
                  </div>
                )}

                <div className="sb-list">
                  {groups.length === 0 && <div className="sb-empty">No groups yet</div>}
                  {groups.map(g => (
                    <button key={g.id} onClick={() => openChat({ type: "group", id: g.id, name: g.name })} className={`sb-item ${activeChat?.id === g.id ? "sb-item--active-group" : ""}`}>
                      <div className="sb-av sb-av--group">{g.name[0].toUpperCase()}</div>
                      <div className="sb-item-body">
                        <span className="sb-item-name">{g.name}</span>
                        <span className="sb-item-sub">{g.members.length} members</span>
                      </div>
                      {unread[g.id] > 0 && <span className="unread unread--purple">{unread[g.id]}</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </aside>

          {/* ── Chat Main ── */}
          <main className="chat">
            {!activeChat ? (
              <div className="empty-state">
                <div className="empty-icon-wrap">
                  <div className="empty-ring r1"></div>
                  <div className="empty-ring r2"></div>
                  <div className="empty-ring r3"></div>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ position: "relative", zIndex: 1 }}><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                </div>
                <h3>Select a conversation</h3>
                <p>Choose a contact or group from the sidebar to start messaging</p>
                <div className="empty-hint">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  All messages are end-to-end encrypted
                </div>
              </div>
            ) : (
              <>
                {/* Chat Header */}
                <header className="chat-hdr">
                  <div className="chat-hdr-left">
                    <button className="mobile-back-btn" onClick={() => setActiveChat(null)}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6"/></svg>
                    </button>
                    <div className={`hdr-av ${activeChat.type === "group" ? "hdr-av--group" : "hdr-av--dm"}`}>
                      {activeChat.name[0].toUpperCase()}
                      {activeChat.type === "user" && (
                        <span className={`hdr-pres ${contacts.find(c => c.phone_number === activeChat.id)?.is_online ? "hdr-pres--on" : ""}`}></span>
                      )}
                    </div>
                    <div className="hdr-info">
                      <span className="hdr-name">{activeChat.name}</span>
                      <span className="hdr-meta">
                        {activeChat.type === "user" ? (
                          contacts.find(c => c.phone_number === activeChat.id)?.is_online ? (
                            <span className="hdr-online">● Online</span>
                          ) : "Offline"
                        ) : (
                          <>{groups.find(g => g.id === activeChat.id)?.members.length || "?"} members</>
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="hdr-right">
                    {activeChat.type === "user" && (
                      <>
                        <button onClick={() => startCall(false)} className="tool-btn" title="Voice Call">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z"/></svg>
                        </button>
                        <button onClick={() => startCall(true)} className="tool-btn" title="Video Call">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                        </button>
                      </>
                    )}
                  </div>
                </header>

                {hasMore && (
                  <div className="load-more-row">
                    <button onClick={() => messages.length && loadHistory(activeChat, messages[0].id)} disabled={loadingMore} className="load-more-btn">
                      {loadingMore ? <><span className="mini-spin"></span>Loading…</> : "↑ Load older messages"}
                    </button>
                  </div>
                )}

                {/* Messages */}
                <div ref={msgListRef} className="msg-list">
                  {groupedMessages.map((item, idx) => (
                    item.type === "divider" ? (
                      <div key={`div-${item.label}-${idx}`} className="date-sep"><span>{item.label}</span></div>
                    ) : (
                      <div key={item.id} className={`msg-row ${item.user === currentUser ? "msg-mine" : "msg-theirs"}`}>
                        {item.is_deleted ? (
                          <div className="msg-deleted">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
                            Message deleted
                          </div>
                        ) : editingId === item.id ? (
                          <div className="edit-row">
                            <input value={editingText} onChange={e => setEditingText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditingId(null); }} className="edit-field" autoFocus/>
                            <button onClick={saveEdit} className="edit-save" title="Save">✓</button>
                            <button onClick={() => setEditingId(null)} className="edit-discard" title="Cancel">✕</button>
                          </div>
                        ) : (
                          <div className="bw">
                            {activeChat.type === "group" && item.user !== currentUser && (
                              <span className="sender-name">{item.user}</span>
                            )}
                            <div className={`bubble ${item.user === currentUser ? "mine" : "theirs"}`}>
                              {renderBubbleContent(item)}

                              <div className="msg-footer">
                                <span className="msg-ts">{formatTime(item.timestamp)}</span>
                                {item.edited_at && <span className="msg-edited">edited</span>}
                                {item.user === currentUser && activeChat.type === "user" && (
                                  <span className={`ticks ${item.is_read ? "ticks--read" : ""}`}>
                                    {item.is_read ? (
                                      <svg width="16" height="10" viewBox="0 0 22 14" fill="none"><path d="M1 7L6 12L15 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M8 7L13 12L22 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                                    ) : (
                                      <svg width="12" height="10" viewBox="0 0 14 14" fill="none"><path d="M1 7L6 12L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                                    )}
                                  </span>
                                )}
                              </div>

                              {/* FIX: Only show edit/delete for text messages */}
                              {item.user === currentUser && (
                                <div className="bubble-actions">
                                  {!isMediaMessage(item.content) && (
                                    <button onClick={e => { e.stopPropagation(); setEditingId(item.id); setEditingText(item.content); }} title="Edit">
                                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                    </button>
                                  )}
                                  <button onClick={e => { e.stopPropagation(); deleteMsg(item.id); }} className="del-action" title="Delete">
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  ))}
                </div>

                {/* Typing indicator */}
                <div className="typing-area">
                  {isTyping && (
                    <div className="typing-pill">
                      <div className="typing-dots"><span></span><span></span><span></span></div>
                      <span>{activeChat.name} is typing</span>
                    </div>
                  )}
                </div>

                {/* Emoji Picker */}
                {showEmojis && (
                  <div className="emoji-picker">
                    {emojis.map(e => <button key={e} onClick={() => setInputMsg(prev => prev + e)} className="emoji-btn">{e}</button>)}
                  </div>
                )}

                {/* Input Bar */}
                <div className="input-bar">
                  <input type="file" ref={fileInputRef} onChange={handleFile} accept="image/*,audio/*,video/mp4,.pdf" style={{ display: "none" }}/>
                  <button onClick={() => setShowEmojis(!showEmojis)} className={`tool-btn ${showEmojis ? "tool-btn--on" : ""}`} title="Emoji">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 13s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                  </button>
                  <button onClick={() => fileInputRef.current?.click()} className="tool-btn" title="Attach file">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                  </button>
                  <button onClick={toggleRecording} className={`tool-btn ${isRecording ? "tool-btn--rec" : ""}`} title={isRecording ? "Stop recording" : "Record voice"}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                    {isRecording && <span className="rec-dot"></span>}
                  </button>
                  <input
                    value={inputMsg}
                    onChange={handleTyping}
                    onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()}
                    placeholder="Type a message…"
                    className="msg-input"
                    disabled={isRecording}
                  />
                  <button onClick={sendMessage} disabled={isRecording || !inputMsg.trim()} className="send-btn" title="Send">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  </button>
                </div>
              </>
            )}
          </main>
        </div>
      )}

      {/* ── File Viewer Modal ── */}
      {viewerSrc && viewerType && (
        <div className="file-viewer-overlay" onClick={() => setViewerSrc(null)}>
          <button className="viewer-close" onClick={() => setViewerSrc(null)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <div className="viewer-inner" onClick={e => e.stopPropagation()}>
            {viewerType === "image" && <img src={viewerSrc} alt="preview" className="viewer-img"/>}
            {viewerType === "video" && <video src={viewerSrc} controls autoPlay className="viewer-video"/>}
            {viewerType === "pdf" && <iframe src={viewerSrc} className="viewer-pdf" title="PDF"/>}
          </div>
        </div>
      )}

      {/* ── WebRTC Call Overlay ── */}
      {callState !== "idle" && (
        <div className="call-overlay">
          <div className={`call-modal ${isVideoCall && callState === "connected" ? "video-active" : ""}`}>
            {isVideoCall && (callState === "connected" || callState === "calling") && (
              <div className="video-container">
                <video ref={remoteVideoRef} className="remote-video" autoPlay playsInline></video>
                <video ref={localVideoRef} className="local-video" autoPlay playsInline muted></video>
              </div>
            )}

            {(!isVideoCall || callState !== "connected") && (
              <div className="call-info">
                <div className={`call-avatar ${callState === "calling" || callState === "incoming" ? "pulse-anim" : ""}`}>
                  {callPeer?.[0]?.toUpperCase()}
                </div>
                <h2 className="call-name">{callPeer}</h2>
                <p className="call-status">
                  {callState === "incoming" ? `Incoming ${isVideoCall ? "Video" : "Voice"} Call…`
                    : callState === "calling" ? "Calling…"
                    : "Connected"}
                </p>
              </div>
            )}

            <div className="call-controls">
              {callState === "incoming" ? (
                <>
                  <button onClick={rejectCall} className="call-btn btn-reject" title="Reject">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                  <button onClick={acceptCall} className="call-btn btn-accept" title="Accept">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z"/></svg>
                  </button>
                </>
              ) : (
                <button onClick={() => endCall(true)} className="call-btn btn-end" title="End Call">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0119 12.55M5 19a10.94 10.94 0 01-1.72-1.49M13.99 5.08A10.93 10.93 0 0112 5c-7 0-11 8-11 8a18.27 18.27 0 005.06 5.94M9.53 14.48A10.24 10.24 0 009 12c0-7 8-11 8-11a18.27 18.27 0 011.94 5.06"/></svg>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
