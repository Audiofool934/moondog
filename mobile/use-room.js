import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { requireNativeModule } from 'expo';
import * as SecureStore from 'expo-secure-store';
import { privateHost } from './address.mjs';

const music = requireNativeModule('MoondogMusic');
const key = 'moondog.iphone.connection';
export function useRoom() {
  const [connection, setConnection] = useState(undefined);
  const [online, setOnline] = useState(false);
  const [messages, setMessages] = useState([]);
  const [turn, setTurn] = useState(null);
  const [player, setPlayer] = useState(null);
  const [access, setAccess] = useState('notDetermined');
  const [notice, setNotice] = useState('');
  const socket = useRef(null);
  const send = useCallback((data) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(data));
    return true;
  }, []);

  useEffect(() => {
    let active = true;
    SecureStore.getItemAsync(key)
      .then((value) => {
        if (active) setConnection(value ? JSON.parse(value) : null);
      })
      .catch(() => {
        if (active) setConnection(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const updateAccess = useCallback(
    async (request) => {
      try {
        const info = await music.access(request);
        setAccess(info.status);
        send({ type: 'access', ready: info.status === 'ready', storefront: info.storefront });
      } catch (error) {
        setNotice(error.message);
        setAccess('unavailable');
        send({ type: 'access', ready: false });
      }
    },
    [send],
  );

  const report = useCallback(
    (state) => {
      setPlayer(state);
      send({ type: 'state', state });
    },
    [send],
  );
  useEffect(() => {
    const sub = music.addListener('onPlayback', report);
    return () => sub.remove();
  }, [report]);

  useEffect(() => {
    if (!connection) return;
    let disposed = false,
      timer,
      attempts = 0,
      current;
    function connect() {
      if (disposed || (current && current.readyState < WebSocket.CLOSING)) return;
      const ws = new WebSocket(`ws://${connection.host}:47831/room`, undefined, {
        headers: { Authorization: `Bearer ${connection.token}` },
      });
      current = ws;
      socket.current = ws;
      ws.onopen = () => {
        if (disposed) return;
        attempts = 0;
        setOnline(true);
        setNotice('');
        void updateAccess(false);
        music
          .state()
          .then(report)
          .catch((error) => setNotice(error.message));
      };
      ws.onmessage = async (event) => {
        if (disposed) return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'room':
            setMessages(msg.messages);
            setTurn(msg.turn);
            break;
          case 'delta':
            setTurn((previous) => previous && { ...previous, assistant: previous.assistant + msg.text });
            break;
          case 'reply':
            setTurn((previous) => previous && { ...previous, assistant: msg.text });
            break;
          case 'notice':
            setNotice(msg.text);
            break;
          case 'play':
          case 'control':
            try {
              if (Date.now() > msg.expires)
                throw new Error('The playback request expired while the phone was disconnected.');
              const state =
                msg.type === 'play'
                  ? await music.play(msg.ids, msg.id)
                  : await music.control(msg.action);
              report(state);
              if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'receipt', id: msg.id, state }));
            } catch (error) {
              setNotice(error.message);
              if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'receipt', id: msg.id, error: error.message }));
            }
            break;
        }
      };
      ws.onerror = () => {
        if (!disposed) setOnline(false);
      };
      ws.onclose = () => {
        if (disposed) return;
        setOnline(false);
        if (AppState.currentState !== 'background')
          timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(attempts++, 4)));
      };
    }
    connect();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        clearTimeout(timer);
        connect();
        void updateAccess(false);
        music
          .state()
          .then(report)
          .catch((error) => setNotice(error.message));
      }
    });
    return () => {
      disposed = true;
      sub.remove();
      clearTimeout(timer);
      socket.current = null;
      current?.close();
      setOnline(false);
    };
  }, [connection, report, updateAccess]);

  async function pair(host, token) {
    const value = { host: host.trim().replace(/:47831$/, ''), token: token.trim() };
    if (!privateHost(value.host) || !/^[A-Za-z0-9_-]{32}$/.test(value.token)) return false;
    await SecureStore.setItemAsync(key, JSON.stringify(value), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    setMessages([]);
    setTurn(null);
    setNotice('');
    setConnection(value);
    return true;
  }
  async function control(action) {
    try {
      report(await music.control(action));
    } catch (error) {
      setNotice(error.message);
    }
  }
  return {
    connection,
    online,
    messages,
    turn,
    player,
    access,
    notice,
    setNotice,
    send,
    pair,
    updateAccess,
    control,
  };
}
