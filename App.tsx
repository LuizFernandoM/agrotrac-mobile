import React, { useEffect, useRef, useState } from 'react';
import { AppState, Alert, Button, Image, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Picker from 'expo-image-picker';
import { randomUUID } from 'expo-crypto';
import { fetch as expoFetch } from 'expo/fetch';
import { canonical, kg, type Row } from './src/domain';
import { apiUrl, openRepository, persistPhoto, transport } from './src/native';
import type { Repository } from './src/repository';
import { SyncCoordinator } from './src/sync';
import { MobileSession } from './src/session';

const fields = [['placa','Placa'],['bruto','Peso bruto (kg)'],['tara','Tara (kg)'],['booking_id','Agendamento UUID (opcional)'],['motorista_nome','Motorista (opcional)'],['motorista_documento','Documento (opcional)'],['observacoes','Observações (opcional)']] as const;
const empty = { placa: '', bruto: '', tara: '', booking_id: '', motorista_nome: '', motorista_documento: '', observacoes: '' };
export default function App() {
  const [form, setForm] = useState(empty), [photo, setPhoto] = useState<Picker.ImagePickerAsset>(), [rows, setRows] = useState<Row[]>([]);
  const [url, setUrl] = useState(process.env.EXPO_PUBLIC_API_URL ?? ''), [message, setMessage] = useState('Inicializando armazenamento…'), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [signedIn, setSignedIn] = useState(false), [authBusy, setAuthBusy] = useState(false), [authMessage, setAuthMessage] = useState('');
  const runtime = useRef<{ repo: Repository; sync: SyncCoordinator; auth: MobileSession } | null>(null), configured = useRef('');
  const authChanging = useRef(false);
  const saving = useRef(false);
  useEffect(() => {
    let alive = true, offNetwork = () => {}, offState = () => {};
    const auth = new MobileSession(active => {
      if (!alive) return;
      setSignedIn(active);
      setAuthMessage(active ? 'Sessão ativa.' : 'Entre para retomar a sincronização.');
    }, expoFetch);
    const refresh = () => { void runtime.current?.repo.list().then(value => { if (alive) setRows(value); }).catch(() => { if (alive) setMessage('Erro ao ler armazenamento.'); }); };
    void (async () => {
      const repo = await openRepository();
      configured.current = await repo.setting('api_url') ?? process.env.EXPO_PUBLIC_API_URL ?? '';
      if (!alive) return;
      setUrl(configured.current);
      const foreground = () => alive && AppState.currentState === 'active';
      const sync = new SyncCoordinator(repo, transport(auth, foreground), refresh, Date.now, () => foreground() && Boolean(auth.current()));
      runtime.current = { repo, sync, auth };
      const trigger = () => { if (AppState.currentState === 'active' && configured.current) void sync.trigger().catch(() => setMessage('Erro no armazenamento da fila. Reinicie e procure suporte.')); };
      offNetwork = NetInfo.addEventListener(state => { if (state.isConnected === true && state.isInternetReachable !== false) trigger(); });
      const subscription = AppState.addEventListener('change', state => { if (state === 'active') trigger(); });
      offState = () => subscription.remove();
      refresh(); setReady(true); setMessage('Pronto para registrar offline.'); trigger();
    })().catch(() => { if (alive) setMessage('Não foi possível abrir o banco local. Procure suporte; dados preservados.'); });
    return () => { alive = false; auth.clear(); offNetwork(); offState(); };
  }, []);
  function syncNow() {
    void runtime.current?.sync.trigger().catch(() => setMessage('Falha de armazenamento durante sync.'));
  }
  async function changeConnection(action: 'url' | 'login' | 'logout') {
    const connection = runtime.current;
    if (!connection || authChanging.current) return;
    authChanging.current = true;
    setAuthBusy(true);
    try {
      if (action === 'url') {
        const value = apiUrl(url);
        await connection.repo.setSetting('api_url', value);
        if (configured.current !== value) connection.auth.clear();
        configured.current = value;
        setUrl(value);
        setAuthMessage(connection.auth.current() ? 'URL salva. Sessão ativa.' : 'URL salva. Entre para sincronizar.');
      } else if (action === 'logout') {
        const status = await connection.auth.logout();
        setAuthMessage(status === undefined || status === 204 || status === 401
          ? 'Sessão encerrada neste aparelho.'
          : 'Sessão encerrada neste aparelho. Revogação no Gateway não confirmada.');
      } else {
        if (!configured.current) { setAuthMessage('Salve a URL do Gateway.'); return; }
        const status = await connection.auth.login(configured.current, username.trim(), password);
        if (status === 200) syncNow();
        else setAuthMessage(status === 401 ? 'Usuário ou senha inválidos.'
          : status === 429 ? 'Muitas tentativas. Aguarde e tente novamente.'
          : status === 400 ? 'Dados de login inválidos.'
          : 'Login indisponível no Gateway.');
      }
    } catch {
      if (action === 'url') Alert.alert('Falha ao salvar URL', 'Confira o endereço HTTP(S) do Gateway e tente novamente.');
      else setAuthMessage(action === 'logout'
        ? 'Sessão encerrada neste aparelho. Revogação no Gateway não confirmada.'
        : 'Não foi possível iniciar sessão. Confira a conexão com o Gateway.');
    } finally {
      if (action === 'login' || action === 'logout') setPassword('');
      authChanging.current = false;
      setAuthBusy(false);
    }
  }
  async function pick(camera: boolean) {
    try {
      if (camera && !(await Picker.requestCameraPermissionsAsync()).granted) { setMessage('Câmera sem permissão. O formulário continua disponível.'); return; }
      const result = camera ? await Picker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8, allowsEditing: false }) : await Picker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false });
      if (!result.canceled) setPhoto(result.assets[0]);
    } catch { setMessage('Não foi possível obter a foto. Tente câmera ou galeria.'); }
  }
  async function save() {
    if (saving.current || !runtime.current) return;
    saving.current = true; setBusy(true);
    try {
      if (!photo) throw Error('Anexe uma foto do romaneio.');
      const payload = canonical({ local_id: randomUUID(), placa: form.placa.trim().toUpperCase(), peso_bruto_kg: kg(form.bruto), tara_kg: kg(form.tara), captured_at: new Date().toISOString(), ...Object.fromEntries(['booking_id','motorista_nome','motorista_documento','observacoes'].map(k => [k, form[k as keyof typeof form] || null])) });
      const savedPhoto = await persistPhoto(photo, payload.local_id);
      await runtime.current.repo.insert({ payload, photo: savedPhoto });
      setRows(await runtime.current.repo.list()); setForm(empty); setPhoto(undefined); setMessage('Pesagem salva no aparelho.');
      void NetInfo.fetch().then(state => {
        if (AppState.currentState === 'active' && state.isConnected !== false && configured.current) void runtime.current?.sync.trigger().catch(() => setMessage('Erro na fila. Dados preservados.'));
      }).catch(() => { /* Saving remains successful even when network discovery fails. */ });
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Falha ao salvar; evidências existentes preservadas.'); }
    finally { saving.current = false; setBusy(false); }
  }
  return <SafeAreaView style={styles.root}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.title}>AgroTrac • Pesagem</Text><Text accessibilityLiveRegion="polite">{message}</Text>
    {fields.map(([key,label]) => <View key={key}><Text>{label}</Text><TextInput accessibilityLabel={label} style={styles.input} value={form[key]} editable={!busy} keyboardType={key === 'bruto' || key === 'tara' ? 'number-pad' : 'default'} autoCapitalize={key === 'placa' ? 'characters' : 'none'} onChangeText={text => setForm(v => ({ ...v, [key]: text }))} /></View>)}
    <Text>Líquido calculado: {/^\d+$/.test(form.bruto) && /^\d+$/.test(form.tara) && Number.isSafeInteger(Number(form.bruto)) && Number.isSafeInteger(Number(form.tara)) && Number(form.bruto) >= Number(form.tara) ? `${Number(form.bruto)-Number(form.tara)} kg` : '—'}</Text>
    <Button title="Fotografar romaneio" disabled={busy} onPress={() => void pick(true)} /><Button title="Selecionar da galeria" disabled={busy} onPress={() => void pick(false)} />
    {photo && <Image source={{ uri: photo.uri }} style={styles.preview} accessibilityLabel="Romaneio selecionado" />}
    <Button title={busy ? 'Salvando…' : 'Salvar pesagem offline'} disabled={!ready || busy} onPress={() => void save()} />
    <Text style={styles.title}>Conexão ao Gateway</Text><TextInput accessibilityLabel="URL do Gateway" autoCapitalize="none" style={styles.input} value={url} editable={!authBusy} onChangeText={setUrl} />
    <Button title="Salvar URL" disabled={!ready || authBusy} onPress={() => void changeConnection('url')} />
    <Text accessibilityLiveRegion="polite">{authMessage || 'Entre para sincronizar as pesagens.'}</Text>
    {signedIn ? <Button title="Sair" disabled={authBusy} onPress={() => void changeConnection('logout')} /> : <>
      <TextInput accessibilityLabel="Usuário" placeholder="Usuário" autoCapitalize="none" autoCorrect={false} style={styles.input} value={username} editable={!authBusy} onChangeText={setUsername} />
      <TextInput accessibilityLabel="Senha" placeholder="Senha" secureTextEntry autoCapitalize="none" autoCorrect={false} style={styles.input} value={password} editable={!authBusy} onChangeText={setPassword} />
      <Button title="Entrar" disabled={!ready || authBusy || !username.trim() || !password} onPress={() => void changeConnection('login')} />
    </>}
    <Button title="Sincronizar agora" disabled={!ready || !signedIn || authBusy} onPress={syncNow} />
    <Text>Sincronização em primeiro plano. Pendências com backoff aguardam o próximo evento após o prazo; erros bloqueados exigem suporte.</Text>
    <Text style={styles.title}>Fila e histórico ({rows.length})</Text>
    {rows.map(r => <View key={r.payload.local_id} style={styles.card}><Text style={styles.bold}>{r.payload.placa} • {r.payload.peso_liquido_kg} kg • {r.status}</Text><Text selectable>{r.payload.local_id}</Text><Text>Tentativas: {r.attempts} {r.auto_retry_blocked ? '• automático bloqueado' : ''}</Text>{r.last_error && <Text>{r.last_error}</Text>}{r.next_attempt_at > 0 && r.status === 'PENDING' && <Text>Próxima tentativa elegível: {new Date(r.next_attempt_at).toLocaleString()}</Text>}{r.sequence && <Text>Confirmação #{r.sequence} • {r.received_at}</Text>}<Image source={{uri:r.photo.uri}} style={styles.thumbnail} /></View>)}
  </ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: '#f4f6ef' }, content: { padding: 20, gap: 12 }, title: { fontSize: 23, fontWeight: '700', color: '#234c32', marginTop: 16 }, input: { borderWidth: 1, borderColor: '#6c7e70', backgroundColor: 'white', borderRadius: 7, padding: 12, color: '#162b1c' }, preview: { height: 200, resizeMode: 'contain' }, thumbnail: { width: 100, height: 75, resizeMode: 'contain' }, card: { backgroundColor: 'white', padding: 14, borderRadius: 8, gap: 6 }, bold: { fontWeight: '700' } });
