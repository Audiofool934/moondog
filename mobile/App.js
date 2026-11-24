import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useRoom } from './use-room';

const zh = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh');
const tr = (en, cn) => (zh ? cn : en);
const record = require('./assets/record.png');
function Room() {
  const room = useRoom();
  const dark = useColorScheme() === 'dark';
  const paper = dark ? '#141413' : '#FAF9F6',
    ink = dark ? '#F1F0ED' : '#252522',
    muted = dark ? '#A8A7A2' : '#676661';
  const [settings, setSettings] = useState(false);
  const host = useRef(''),
    token = useRef(''),
    draft = useRef(''),
    composer = useRef(null);
  const [formError, setFormError] = useState(''),
    [hasDraft, setHasDraft] = useState(false),
    [queueOpen, setQueueOpen] = useState(false);
  const scroll = useRef(null),
    follow = useRef(true);
  const setup = settings || room.connection === null;
  const playback = room.player,
    current = playback?.tracks?.[playback.index];
  const button = (label, onPress, options = {}) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={options.hint || label}
      disabled={options.disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        { opacity: pressed || options.disabled ? 0.45 : 1 },
        options.primary && { backgroundColor: ink, borderRadius: 24, paddingHorizontal: 24 },
      ]}
    >
      <Text
        style={{
          fontSize: options.large ? 23 : 16,
          fontWeight: '500',
          color: options.primary ? paper : ink,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
  const label = (text) => <Text style={[s.label, { color: muted }]}>{text}</Text>;
  const field = { color: ink, backgroundColor: dark ? '#242422' : '#EFEEEA' };
  useEffect(() => {
    if (room.connection) {
      host.current = room.connection.host;
      token.current = room.connection.token;
    }
  }, [room.connection]);
  async function connect() {
    try {
      if (await room.pair(host.current, token.current)) {
        Keyboard.dismiss();
        setFormError('');
        setSettings(false);
      } else
        setFormError(
          tr(
            'Enter the Tailscale IPv4 address and the 32-character key from your Mac.',
            '请输入 Mac 的 Tailscale IPv4 地址和 32 位配对密钥。',
          ),
        );
    } catch (error) {
      setFormError(error.message);
    }
  }
  function submit() {
    const text = draft.current.trim();
    if (text && !room.turn && room.send({ type: 'prompt', text })) {
      follow.current = true;
      draft.current = '';
      setHasDraft(false);
      composer.current?.clear();
      Keyboard.dismiss();
    }
  }
  const albumButton = () =>
    current
      ? room.control(playback.status === 'playing' ? 'pause' : 'resume')
      : room.send({ type: 'prompt', text: tr('Play something for right now', '放几首适合现在听的歌') });
  const askMusic = () =>
    room.access === 'denied'
      ? Linking.openSettings().catch((error) => room.setNotice(error.message))
      : room.updateAccess(true);
  return (
    <SafeAreaView style={[s.safe, { backgroundColor: paper }]}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <KeyboardAvoidingView style={s.safe} behavior="padding">
        <View style={s.bar}>
          <Text accessibilityRole="header" style={[s.brand, { color: ink }]}>
            Moondog
          </Text>
          {room.connection &&
            button(setup ? tr('Done', '完成') : tr('Connection', '连接'), () => {
              setFormError('');
              host.current = room.connection.host;
              token.current = room.connection.token;
              setSettings(!setup);
            })}
        </View>
        {room.connection === undefined ? (
          <ActivityIndicator style={s.center} color={ink} />
        ) : setup ? (
          <ScrollView
            contentContainerStyle={s.setup}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            <Image
              source={record}
              style={[s.mark, { tintColor: ink }]}
              accessibilityIgnoresInvertColors
            />
            <Text accessibilityRole="header" style={[s.title, { color: ink }]}>
              {tr('Connect to your Mac', '连接你的 Mac')}
            </Text>
            <Text style={[s.body, { color: muted }]}>
              {tr(
                'Open the Moondog host on your Mac and connect both devices to Tailscale.',
                '在 Mac 上启动 Moondog 服务，并将两台设备连入 Tailscale。',
              )}
            </Text>
            {label(tr('Mac address', 'Mac 地址'))}
            <TextInput
              accessibilityLabel={tr('Mac address', 'Mac 地址')}
              defaultValue={room.connection?.host || ''}
              onChangeText={(value) => {
                host.current = value;
              }}
              style={[s.input, field]}
              placeholder="100.x.x.x"
              placeholderTextColor={muted}
              keyboardType="ascii-capable"
              autoCapitalize="none"
              spellCheck={false}
              autoCorrect={false}
            />
            {label(tr('Pairing key', '配对密钥'))}
            <TextInput
              accessibilityLabel={tr('Pairing key', '配对密钥')}
              defaultValue={room.connection?.token || ''}
              onChangeText={(value) => {
                token.current = value;
              }}
              style={[s.input, field]}
              placeholder={tr('Key from your Mac', 'Mac 上显示的密钥')}
              placeholderTextColor={muted}
              secureTextEntry
              textContentType="oneTimeCode"
              autoCorrect={false}
              autoCapitalize="none"
              onSubmitEditing={connect}
            />
            {!!formError && <Text style={[s.body, { color: ink }]}>{formError}</Text>}
            <View style={s.action}>{button(tr('Connect', '连接'), connect, { primary: true })}</View>
          </ScrollView>
        ) : (
          <>
            <ScrollView
              ref={scroll}
              style={s.safe}
              contentContainerStyle={s.conversation}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              onScroll={({ nativeEvent: e }) => {
                follow.current =
                  e.contentOffset.y + e.layoutMeasurement.height >= e.contentSize.height - 65;
              }}
              scrollEventThrottle={80}
              onContentSizeChange={() => {
                if (follow.current) scroll.current?.scrollToEnd({ animated: false });
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  current ? tr('Toggle playback', '播放或暂停') : tr('Play something', '放些音乐')
                }
                onPress={albumButton}
                disabled={!current && (!room.online || room.access !== 'ready' || !!room.turn)}
                style={s.disc}
              >
                <Image source={record} style={[s.discArt, { tintColor: ink }]} />
              </Pressable>
              {!room.online && (
                <Text style={[s.centerText, { color: muted }]}>
                  {tr(
                    'Waiting for your Mac. Check Tailscale and the pairing key.',
                    '正在连接 Mac。请检查 Tailscale 和配对密钥。',
                  )}
                </Text>
              )}
              {room.online && room.access !== 'ready' && (
                <View style={s.musicAccess}>
                  {button(
                    room.access === 'subscription'
                      ? tr('Check Apple Music subscription', '检查 Apple Music 订阅')
                      : tr('Connect Apple Music', '连接 Apple Music'),
                    askMusic,
                  )}
                </View>
              )}
              {room.messages.map((m, i) => (
                <Text
                  selectable
                  key={i}
                  style={[
                    s.message,
                    { color: m.role === 'assistant' ? ink : muted },
                    m.role === 'user' && s.user,
                  ]}
                >
                  {m.text}
                </Text>
              ))}
              {room.turn && (
                <>
                  <Text style={[s.message, s.user, { color: muted }]}>{room.turn.user}</Text>
                  <Text selectable style={[s.message, { color: ink }]}>
                    {room.turn.assistant || '···'}
                  </Text>
                </>
              )}
              {!!room.notice && (
                <Text selectable style={[s.body, { color: muted }]}>
                  {room.notice}
                </Text>
              )}
            </ScrollView>
            {!!current && (
              <View style={s.player}>
                <View style={s.nowRow}>
                  <Pressable
                    style={s.nowTitle}
                    onPress={() => setQueueOpen(!queueOpen)}
                    accessibilityRole="button"
                    accessibilityLabel={tr('Show queue', '查看队列')}
                  >
                    <Text numberOfLines={1} style={[s.song, { color: ink }]}>
                      {current.title}
                    </Text>
                    <Text numberOfLines={1} style={{ color: muted }}>
                      {current.artist}
                    </Text>
                  </Pressable>
                  {button(playback.status === 'playing' ? 'Ⅱ' : '▷', albumButton, {
                    hint: tr('Play or pause', '播放或暂停'),
                    large: true,
                  })}
                  {button('›', () => room.control('next'), {
                    hint: tr('Next song', '下一首'),
                    large: true,
                    disabled: playback.index + 1 >= playback.tracks.length,
                  })}
                </View>
                {queueOpen && (
                  <ScrollView style={s.queue}>
                    {label(tr('Up next', '接下来'))}
                    {playback.tracks.slice(playback.index + 1).map((t, i) => (
                      <Text key={i} numberOfLines={1} style={[s.queueItem, { color: ink }]}>
                        {t.title} · {t.artist}
                      </Text>
                    ))}
                  </ScrollView>
                )}
              </View>
            )}
            <View style={[s.composer, field]}>
              <TextInput
                multiline
                accessibilityLabel={tr('Message', '消息')}
                ref={composer}
                defaultValue={draft.current}
                onChangeText={(value) => {
                  draft.current = value;
                  setHasDraft(Boolean(value.trim()));
                }}
                maxLength={8000}
                style={[s.draft, { color: ink }]}
                placeholder={tr('Ask Moondog…', '和 Moondog 说点什么…')}
                placeholderTextColor={muted}
              />
              {room.turn
                ? button('■', () => room.send({ type: 'cancel' }), {
                    hint: tr('Stop reply', '停止回复'),
                  })
                : button('↑', submit, {
                    hint: tr('Send', '发送'),
                    large: true,
                    disabled: !room.online || !hasDraft,
                  })}
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <Room />
    </SafeAreaProvider>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1 },
  bar: {
    paddingHorizontal: 22,
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: { fontFamily: 'Georgia', fontSize: 26 },
  button: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  setup: {
    paddingHorizontal: 28,
    paddingVertical: 25,
    maxWidth: 540,
    alignSelf: 'center',
    width: '100%',
  },
  mark: { width: 94, height: 94, marginBottom: 22 },
  title: { fontSize: 30, fontFamily: 'Georgia', marginBottom: 10 },
  body: { fontSize: 16, lineHeight: 23, marginBottom: 12 },
  label: { fontSize: 14, marginBottom: 7, marginTop: 15 },
  input: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, minHeight: 48, fontSize: 17 },
  action: { alignSelf: 'flex-start', marginTop: 24 },
  center: { flex: 1 },
  centerText: { alignSelf: 'center', textAlign: 'center', marginBottom: 16 },
  disc: { alignSelf: 'center', padding: 8, marginVertical: 16 },
  discArt: { width: 154, height: 154 },
  musicAccess: { alignSelf: 'center', marginBottom: 14 },
  conversation: { paddingHorizontal: 22, paddingBottom: 18 },
  message: { fontSize: 17, lineHeight: 25, marginTop: 12 },
  user: { alignSelf: 'flex-end', maxWidth: '88%', marginTop: 24 },
  player: { paddingHorizontal: 22, paddingVertical: 8 },
  nowRow: { flexDirection: 'row', alignItems: 'center' },
  nowTitle: { flex: 1, justifyContent: 'center', minHeight: 44 },
  song: { fontSize: 16, fontWeight: '600' },
  queue: { maxHeight: 154 },
  queueItem: { fontSize: 15, marginVertical: 4 },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 22,
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 6,
    paddingHorizontal: 8,
  },
  draft: {
    flex: 1,
    minHeight: 46,
    maxHeight: 112,
    paddingVertical: 12,
    paddingHorizontal: 10,
    fontSize: 17,
  },
});
