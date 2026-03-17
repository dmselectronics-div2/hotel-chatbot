import { useState, useRef, useEffect, useCallback } from 'react'

// ── API endpoints ──────────────────────────────────────────────────────────────
const GEMINI_URL     = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
const GEMINI_TTS_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent'
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech'

// ── Keys from .env ─────────────────────────────────────────────────────────────
const ENV_GOOGLE_KEY = import.meta.env.VITE_GOOGLE_KEY || ''
const ENV_OPENAI_KEY = import.meta.env.VITE_OPENAI_KEY?.startsWith('sk-') ? import.meta.env.VITE_OPENAI_KEY : ''

// ── Gemini TTS voices ─────────────────────────────────────────────────────────
// Aoede — natural female, handles multilingual incl. Sinhala
const GEMINI_VOICE_SI = 'Aoede'
const GEMINI_VOICE_EN = 'Zephyr'

// ── PCM → WAV conversion (Gemini TTS returns raw PCM, browsers need WAV) ──────
function pcmToWav(pcmBytes, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const dataLen  = pcmBytes.byteLength
  const buf      = new ArrayBuffer(44 + dataLen)
  const view     = new DataView(buf)
  const str      = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  str(0,  'RIFF');  view.setUint32(4,  36 + dataLen, true)
  str(8,  'WAVE');  str(12, 'fmt ')
  view.setUint32(16, 16, true)                              // PCM chunk size
  view.setUint16(20, 1,  true)                              // PCM format
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bitDepth / 8, true)
  view.setUint16(32, channels * bitDepth / 8, true)
  view.setUint16(34, bitDepth, true)
  str(36, 'data'); view.setUint32(40, dataLen, true)
  new Uint8Array(buf, 44).set(pcmBytes)
  return buf
}

// ── Booking helpers ────────────────────────────────────────────────────────────
function extractBooking(text) {
  const match = text.match(/BOOKING_CONFIRMED:(\{[^}]+\})/)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}

function cleanBotText(text) {
  return text.replace(/\s*BOOKING_CONFIRMED:\{[^}]+\}\s*$/, '').trim()
}

// Strip emojis — TTS engines read them as "waving hand emoji" etc.
function stripEmojis(text) {
  return text
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function exportToCSV(bookings) {
  const headers = ['ID', 'Guest Name', 'Room Type', 'Check-in', 'Check-out', 'Nights', 'Total (LKR)', 'Contact', 'Booked At']
  const rows    = bookings.map(b => [b.id, b.name, b.room, b.checkin, b.checkout, b.nights, b.total, b.contact, b.bookedAt])
  const csv     = [headers, ...rows]
    .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = `royal_lanka_bookings_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ── System prompts ─────────────────────────────────────────────────────────────
const BASE_PROMPTS = {
  en: `You are an AI reservation assistant for Royal Lanka Hotels, a luxury hotel chain in Sri Lanka.
Respond ONLY in English. Be friendly, professional, and concise (2–4 sentences max per reply).
Help with room bookings, check-in/check-out, room types, pricing, facilities, dining, and general inquiries.
Room types: Standard (LKR 8,000/night), Deluxe (LKR 12,000/night), Suite (LKR 18,000/night).
Check-in: 2:00 PM | Check-out: 12:00 PM.
Buffet: Breakfast, Lunch, Dinner. Dinner buffet: LKR 3,500/person.
Facilities: Swimming pool, gym, free WiFi, parking, spa.
Payment: Credit card, debit card, online payment accepted.
For bookings, collect: guest name, room type, check-in date, check-out date, then contact (email/mobile).
If the requested room type overlaps with an existing booking listed below, tell the guest it is unavailable and suggest another room type.`,

  si: `ඔබ රෝයල් ලංකා හෝටල්ස් හි AI වෙන්කිරීමේ සහාය කාරකයා ය.
සිංහල භාෂාවෙන් පමණක් පිළිතුරු දෙන්න. කෙටි, මිත්‍රශීලී හා වෘත්තීයමය ලෙස (පිළිතුරු 2–3 වාක්‍ය) සිටින්න.
කාමර වර්ග: Standard (රු. 8,000/රාත්‍රී), Deluxe (රු. 12,000/රාත්‍රී), Suite (රු. 18,000/රාත්‍රී).
ඇතුළු වීම: දහවල් 2:00 | පිටව යාම: පෙරවරු 12:00.
බෆේ: උදෑසන, දහවල්, රාත්‍රී. රාත්‍රී: රු. 3,500/පුද්ගලයෙකු.
පහසුකම්: pool, gym, WiFi, parking, spa. ගෙවීම: credit card, debit card, online.
ස්තූතිය + ලබා ගත් නම ඇමතීමෙන් සිංහලෙන් පිළිතුරු දෙන්න.
ඉල්ලූ කාමර වර්ගය පහත ලැයිස්තුවේ දිනයන් සමග ගැටෙන්නේ නම්, ගෙස්ට් ට දන්වා වෙනත් කාමර යෝජනා කරන්න.
IMPORTANT: The BOOKING_CONFIRMED marker must always be written in English JSON even when replying in Sinhala.`,
}

function buildSystemMessage(lang, bookings) {
  const today     = new Date()
  const todayStr  = today.toISOString().slice(0, 10)
  const todayLong = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  const dateCtx = `\n\nTODAY'S DATE: ${todayStr} (${todayLong}).
DATE RULE: Always resolve relative dates ("ලබන මාස දෙවැනිදා", "next Friday", "tomorrow") to YYYY-MM-DD using today's date. State the resolved date back to the guest before confirming.`

  const bookedList = bookings.length
    ? '\n\nEXISTING BOOKINGS (check conflicts before confirming):\n' +
      bookings.map(b => `• ${b.room}: ${b.checkin} to ${b.checkout} (Guest: ${b.name})`).join('\n')
    : '\n\nEXISTING BOOKINGS: None yet.'

  const rule = `\n\nBOOKING CONFIRMATION RULE: Once you have ALL details (name, room type, check-in YYYY-MM-DD, check-out YYYY-MM-DD, contact) AND no conflict exists, append EXACTLY at the very end:\nBOOKING_CONFIRMED:{"name":"VALUE","room":"VALUE","checkin":"YYYY-MM-DD","checkout":"YYYY-MM-DD","nights":N,"total":N,"contact":"VALUE"}`

  return BASE_PROMPTS[lang] + dateCtx + bookedList + rule
}

// ── Quick actions & greetings ──────────────────────────────────────────────────
const QUICK_ACTIONS = {
  en: [
    { label: 'Book a Room',  msg: 'I want to book a room' },
    { label: 'Room Types',   msg: 'Show me available room types and prices' },
    { label: 'Dining',       msg: 'Tell me about dining options' },
    { label: 'Check-out',    msg: 'What is the check-out process?' },
  ],
  si: [
    { label: 'කාමරය වෙන්කරන්න', msg: 'මට කාමරයක් වෙන් කරගන්න ඕනෑ' },
    { label: 'කාමර වර්ග',        msg: 'ඇති කාමර වර්ග සහ මිල ගණන් පෙන්නන්න' },
    { label: 'ආහාර',             msg: 'ආහාර පහසුකම් ගැන කියන්න' },
    { label: 'ගෙවීම',            msg: 'ගෙවීම සිදු කරන්නේ කොහොමද?' },
  ],
}

const GREETINGS = {
  en: "Hello! Welcome to Royal Lanka Hotels. How can I assist you today?",
  si: "ආයුබෝවන්! රෝයල් ලංකා හෝටල්ස් වෙත සාදරයෙන් පිළිගනිමු. අද ඔබට කෙසේ උදව් කළ හැකිද?",
}

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const formatTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// ══════════════════════════════════════════════════════════════════════════════
export default function ChatBot() {
  const [keySet]                      = useState(() => !!ENV_GOOGLE_KEY)
  const [lang, setLang]               = useState(null)
  const [messages, setMessages]       = useState([])
  const [input, setInput]             = useState('')
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking]   = useState(false)
  const [isLoading, setIsLoading]     = useState(false)
  const [autoMode, setAutoMode]       = useState(true)
  const [bookings, setBookings]       = useState(() => {
    try { return JSON.parse(localStorage.getItem('rl_bookings') || '[]') } catch { return [] }
  })

  const systemContentRef = useRef('')
  const historyRef       = useRef([])
  const recognitionRef   = useRef(null)
  const messagesEndRef   = useRef(null)
  const inputRef         = useRef(null)
  const langRef          = useRef(null)
  const autoModeRef      = useRef(true)
  const liveIdRef        = useRef(null)
  const audioRef         = useRef(null)
  const isSpeakingRef    = useRef(false)
  const isListeningRef   = useRef(false)
  const bookingsRef      = useRef(bookings)

  useEffect(() => { langRef.current     = lang },     [lang])
  useEffect(() => { autoModeRef.current = autoMode }, [autoMode])
  useEffect(() => {
    bookingsRef.current = bookings
    localStorage.setItem('rl_bookings', JSON.stringify(bookings))
  }, [bookings])
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, isLoading])

  const addMsg = (sender, text, extra = {}) =>
    setMessages(prev => [...prev, { sender, text, time: formatTime(), ...extra }])

  const stopSpeaking = () => {
    window.speechSynthesis?.cancel()
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    isSpeakingRef.current = false
    setIsSpeaking(false)
  }

  const stopListening = () => {
    recognitionRef.current?.stop()
    isListeningRef.current = false
    setIsListening(false)
  }

  // ── Gemini TTS ─────────────────────────────────────────────────────────────
  const speakWithGemini = useCallback(async (text, speechLang, onDone) => {
    if (!text || !ENV_GOOGLE_KEY) return false
    try {
      stopSpeaking()
      isSpeakingRef.current = true
      setIsSpeaking(true)

      const voice = speechLang === 'si-LK' ? GEMINI_VOICE_SI : GEMINI_VOICE_EN
      const res = await fetch(`${GEMINI_TTS_URL}?key=${ENV_GOOGLE_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
            },
          },
        }),
      })
      if (!res.ok) throw new Error('Gemini TTS error')

      const data      = await res.json()
      const part      = data.candidates?.[0]?.content?.parts?.[0]?.inlineData
      if (!part?.data) throw new Error('No audio data from Gemini TTS')

      // Decode base64 audio (WAV/PCM returned by Gemini TTS)
      const pcm      = Uint8Array.from(atob(part.data), c => c.charCodeAt(0))
      // Gemini TTS returns raw PCM — must wrap in WAV header for browser playback
      const sampleRate = parseInt((part.mimeType || '').match(/rate=(\d+)/)?.[1] || '24000')
      const wavBuf   = pcmToWav(pcm, sampleRate)
      const blob     = new Blob([wavBuf], { type: 'audio/wav' })
      const url   = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio

      const cleanup = () => {
        isSpeakingRef.current = false
        setIsSpeaking(false)
        audioRef.current = null
        URL.revokeObjectURL(url)
      }
      audio.onended = () => { cleanup(); onDone?.() }
      audio.onerror = () => { cleanup(); onDone?.() }
      audio.play()
      return true
    } catch {
      isSpeakingRef.current = false
      setIsSpeaking(false)
      return false
    }
  }, [])

  // ── OpenAI TTS fallback ────────────────────────────────────────────────────
  const speakWithOpenAI = useCallback(async (text, onDone) => {
    if (!text || !ENV_OPENAI_KEY) return false
    try {
      stopSpeaking()
      isSpeakingRef.current = true
      setIsSpeaking(true)

      const res = await fetch(OPENAI_TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ENV_OPENAI_KEY}` },
        body: JSON.stringify({ model: 'tts-1', input: text, voice: 'nova', response_format: 'mp3' }),
      })
      if (!res.ok) throw new Error('OpenAI TTS error')

      const blob  = await res.blob()
      const url   = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio

      const cleanup = () => {
        isSpeakingRef.current = false
        setIsSpeaking(false)
        audioRef.current = null
        URL.revokeObjectURL(url)
      }
      audio.onended = () => { cleanup(); onDone?.() }
      audio.onerror = () => { cleanup(); onDone?.() }
      audio.play()
      return true
    } catch {
      isSpeakingRef.current = false
      setIsSpeaking(false)
      return false
    }
  }, [])

  // ── Browser TTS last resort ────────────────────────────────────────────────
  const speakWithBrowser = useCallback((text, speechLang, onDone) => {
    if (!window.speechSynthesis || !text) { onDone?.(); return }
    stopSpeaking()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang  = speechLang
    utterance.rate  = 0.95
    const voices = window.speechSynthesis.getVoices()
    const voice  = voices.find(v => v.lang === speechLang) ||
                   voices.find(v => v.lang.startsWith(speechLang.split('-')[0]))
    if (voice) utterance.voice = voice
    utterance.onstart = () => { isSpeakingRef.current = true; setIsSpeaking(true) }
    utterance.onend   = () => { isSpeakingRef.current = false; setIsSpeaking(false); onDone?.() }
    utterance.onerror = () => { isSpeakingRef.current = false; setIsSpeaking(false); onDone?.() }
    const go = () => window.speechSynthesis.speak(utterance)
    if (voices.length === 0) {
      window.speechSynthesis.onvoiceschanged = () => { window.speechSynthesis.onvoiceschanged = null; go() }
    } else { go() }
  }, [])

  // ── Main speak: Gemini TTS → OpenAI TTS → browser ─────────────────────────
  const speak = useCallback(async (text, speechLang, onDone) => {
    if (!text) { onDone?.(); return }
    const clean = stripEmojis(text)
    if (!clean) { onDone?.(); return }

    const ok = await speakWithGemini(clean, speechLang, onDone)
    if (ok) return
    const ok2 = await speakWithOpenAI(clean, onDone)
    if (ok2) return
    speakWithBrowser(clean, speechLang, onDone)
  }, [speakWithGemini, speakWithOpenAI, speakWithBrowser])

  // ── Speech Recognition ─────────────────────────────────────────────────────
  const startListening = useCallback((speechLang) => {
    if (!SpeechRecognition || isListeningRef.current || isSpeakingRef.current) return
    stopListening()

    const liveId = Date.now()
    liveIdRef.current = liveId
    setMessages(prev => [...prev, { sender: 'user', text: '🎙 …', time: formatTime(), isLive: true, liveId }])

    const rec = new SpeechRecognition()
    rec.lang           = speechLang || (langRef.current === 'si' ? 'si-LK' : 'en-US')
    rec.interimResults = true
    rec.continuous     = false

    rec.onresult = (e) => {
      const results    = Array.from(e.results)
      const transcript = results.map(r => r[0].transcript).join('')
      setInput(transcript)
      const id = liveIdRef.current
      if (id && transcript.trim()) {
        setMessages(prev => prev.map(m => m.liveId === id ? { ...m, text: `🎙 ${transcript}` } : m))
      }
      if (results[results.length - 1]?.isFinal && transcript.trim()) {
        rec.stop()
        sendMessageRef.current?.(transcript.trim())
      }
    }
    rec.onend = () => {
      isListeningRef.current = false
      setIsListening(false)
      const id = liveIdRef.current
      setMessages(prev => prev.map(m =>
        (m.liveId === id && m.text === '🎙 …') ? { ...m, text: '🎙 (no speech detected)' } : m
      ))
    }
    rec.onerror = () => {
      isListeningRef.current = false
      setIsListening(false)
      const id = liveIdRef.current
      setMessages(prev => prev.filter(m => m.liveId !== id))
      liveIdRef.current = null
    }

    recognitionRef.current = rec
    rec.start()
    isListeningRef.current = true
    setIsListening(true)
  }, [])

  // ── Send → Gemini → speak → listen ────────────────────────────────────────
  const sendMessageRef = useRef(null)

  const sendMessage = useCallback(async (text) => {
    if (!text?.trim() || !keySet) return
    const currentLang = langRef.current
    if (!currentLang) return

    const speechLang = currentLang === 'si' ? 'si-LK' : 'en-US'
    const liveId     = liveIdRef.current
    liveIdRef.current = null

    if (liveId) {
      setMessages(prev => prev.map(m =>
        m.liveId === liveId ? { sender: 'user', text: text.trim(), time: formatTime() } : m
      ))
    } else {
      addMsg('user', text.trim())
    }
    setInput('')
    setIsLoading(true)

    const userMsg  = { role: 'user',  parts: [{ text: text.trim() }] }
    const contents = [...historyRef.current, userMsg]

    try {
      const res = await fetch(`${GEMINI_URL}?key=${ENV_GOOGLE_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemContentRef.current }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 500 },
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error?.message || `Gemini error ${res.status}`)
      }
      const data     = await res.json()
      const rawReply = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

      const booking     = extractBooking(rawReply)
      const displayText = cleanBotText(rawReply)

      historyRef.current = [...contents, { role: 'model', parts: [{ text: rawReply }] }]

      if (booking) {
        const newBooking = {
          ...booking,
          id:       `RLH-${Date.now()}`,
          bookedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        }
        setBookings(prev => {
          const updated = [...prev, newBooking]
          systemContentRef.current = buildSystemMessage(langRef.current, updated)
          return updated
        })
        addMsg('bot', displayText)
        addMsg('bot',
          `Booking confirmed!\nID: ${newBooking.id}\nRoom: ${newBooking.room} - ${newBooking.checkin} to ${newBooking.checkout}\nTotal: LKR ${Number(newBooking.total).toLocaleString()}`,
          { isBooking: true }
        )
      } else {
        addMsg('bot', displayText)
      }

      setIsLoading(false)
      speak(displayText, speechLang, () => {
        if (autoModeRef.current) startListening(speechLang)
      })
    } catch (err) {
      setIsLoading(false)
      addMsg('bot', `Error: ${err.message}`, { isError: true })
    }
  }, [keySet, speak, startListening])

  useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage])

  // ── Language selection ─────────────────────────────────────────────────────
  const selectLanguage = useCallback((selectedLang) => {
    const speechLang = selectedLang === 'si' ? 'si-LK' : 'en-US'
    setLang(selectedLang)
    langRef.current          = selectedLang
    systemContentRef.current = buildSystemMessage(selectedLang, bookingsRef.current)
    historyRef.current       = []

    const greeting = GREETINGS[selectedLang]
    setMessages([{ sender: 'bot', text: greeting, time: formatTime() }])

    setTimeout(() => {
      speak(greeting, speechLang, () => {
        if (autoModeRef.current) startListening(speechLang)
      })
    }, 300)
  }, [speak, startListening])

  const toggleMic = () => {
    if (!SpeechRecognition) { alert('Use Chrome for speech recognition.'); return }
    if (isListening) { stopListening(); return }
    startListening(langRef.current === 'si' ? 'si-LK' : 'en-US')
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!input.trim() || !lang || isLoading) return
    sendMessage(input.trim())
  }

  // ── Splash ─────────────────────────────────────────────────────────────────
  if (!lang) {
    return (
      <div className="splash">
        <div className="splash-inner">
          <div className="splash-icon">🏨</div>
          <h1>Royal Lanka Hotels</h1>
          <p className="splash-sub">AI Voice Concierge · Gemini + Gemini TTS</p>

          {bookings.length > 0 && (
            <div className="bookings-banner">
              <span>📋 {bookings.length} booking{bookings.length !== 1 ? 's' : ''} on record</span>
              <div className="banner-btns">
                <button className="banner-btn" onClick={() => exportToCSV(bookings)}>Export Excel</button>
                <button className="banner-btn danger" onClick={() => {
                  if (window.confirm('Clear all bookings?')) { setBookings([]); localStorage.removeItem('rl_bookings') }
                }}>Clear</button>
              </div>
            </div>
          )}

          {!keySet ? (
            <div className="key-box">
              <p className="key-hint">No Google API key found. Add VITE_GOOGLE_KEY to .env</p>
            </div>
          ) : (
            <div className="lang-picker">
              <p className="lang-hint">Choose your language / භාෂාව තෝරන්න</p>
              <div className="lang-btns">
                <button className="lang-btn en" onClick={() => selectLanguage('en')}>
                  <span className="flag">🇬🇧</span>
                  <strong>English</strong>
                  <span className="lang-sub">Continue in English</span>
                </button>
                <button className="lang-btn si" onClick={() => selectLanguage('si')}>
                  <span className="flag">🇱🇰</span>
                  <strong>සිංහල</strong>
                  <span className="lang-sub">සිංහලෙන් ඉදිරියට යන්න</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Chat UI ────────────────────────────────────────────────────────────────
  return (
    <div className="chat-wrapper">
      <div className="chat-container">

        <header className="chat-header">
          <div className="header-left">
            <div className="hotel-avatar">🏨</div>
            <div>
              <h1>Royal Lanka Hotels</h1>
              <p>AI Voice Concierge · {lang === 'si' ? 'සිංහල' : 'English'}</p>
            </div>
          </div>
          <div className="header-right">
            {isSpeaking && (
              <div className="wave-indicator"><span/><span/><span/><span/><span/></div>
            )}
            {bookings.length > 0 && (
              <button className="export-btn" onClick={() => exportToCSV(bookings)} title="Export bookings">
                📋 {bookings.length}
              </button>
            )}
            <button className={`auto-badge ${autoMode ? 'on' : 'off'}`} onClick={() => setAutoMode(v => !v)}>
              {autoMode ? 'Auto' : 'Manual'}
            </button>
            <button className="back-btn" onClick={() => {
              stopSpeaking(); stopListening()
              setLang(null); setMessages([]); historyRef.current = []
            }}>Back</button>
          </div>
        </header>

        <div className="status-bar">
          {isSpeaking  && <span className="status speaking">Speaking…</span>}
          {isListening && <span className="status listening">Listening…</span>}
          {isLoading   && <span className="status thinking">Thinking…</span>}
          {!isSpeaking && !isListening && !isLoading && (
            <span className="status idle">
              {autoMode ? 'Auto mode — speaks then listens' : 'Manual mode — click mic to speak'}
            </span>
          )}
        </div>

        <div className="chat-messages">
          {messages.map((msg, i) => (
            <div key={msg.liveId || i} className={`msg ${msg.sender}${msg.isError ? ' error' : ''}${msg.isBooking ? ' booking-confirm' : ''}`}>
              {msg.sender === 'bot' && <div className="bot-avatar">🏨</div>}
              <div className="msg-body">
                <div className={`bubble${msg.isLive ? ' live' : ''}${msg.isBooking ? ' booking-bubble' : ''}`}>
                  {msg.isBooking
                    ? msg.text.split('\n').map((l, j) => <div key={j}>{l}</div>)
                    : msg.text}
                </div>
                {msg.isBooking && (
                  <button className="export-inline-btn" onClick={() => exportToCSV(bookings)}>
                    Export bookings to Excel
                  </button>
                )}
                <span className="msg-time">{msg.time}</span>
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="msg bot">
              <div className="bot-avatar">🏨</div>
              <div className="msg-body">
                <div className="bubble typing"><span/><span/><span/></div>
                <span className="msg-time">thinking…</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="quick-bar">
          <span className="quick-label">{lang === 'si' ? 'ශීඝ්‍ර:' : 'Quick:'}</span>
          <div className="quick-btns">
            {QUICK_ACTIONS[lang].map(a => (
              <button key={a.label} className="quick-btn" disabled={isLoading || isListening}
                onClick={() => { stopSpeaking(); sendMessage(a.msg) }}>
                {a.label}
              </button>
            ))}
          </div>
        </div>

        <form className="input-bar" onSubmit={handleSubmit}>
          <div className={`input-box ${isListening ? 'active' : ''}`}>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={isListening
                ? (lang === 'si' ? 'ඇහෙමින්...' : 'Listening…')
                : (lang === 'si' ? 'ඔබේ පණිවිඩය ටයිප් කරන්න...' : 'Type your message…')}
              disabled={isLoading}
            />
            <button type="button" className={`mic-btn ${isListening ? 'on' : ''}`}
              onClick={toggleMic} disabled={isLoading || isSpeaking}>
              {isListening ? '⏹' : '🎙'}
            </button>
          </div>
          <button type="submit" className="send-btn" disabled={!input.trim() || isLoading}>➤</button>
        </form>

        <div className="chat-footer">
          <span>Royal Lanka Hotels © 2025</span>
          <span className="dot">·</span>
          <span className="tts-badge">Gemini 2.0 · Gemini TTS</span>
          {bookings.length > 0 && (
            <>
              <span className="dot">·</span>
              <button className="footer-export-btn" onClick={() => exportToCSV(bookings)}>
                {bookings.length} booking{bookings.length !== 1 ? 's' : ''} — Export
              </button>
            </>
          )}
        </div>

      </div>
    </div>
  )
}
