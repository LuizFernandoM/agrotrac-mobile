import React, { useEffect, useRef, useState } from 'react';
import { AppState, Alert, Button, Image, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Picker from 'expo-image-picker';
import { randomUUID } from 'expo-crypto';
import { canonical, kg, type Row } from './src/domain';
import { apiUrl, openRepository, persistPhoto, transport } from './src/native';
import type { Repository } from './src/repository';
import { SyncCoordinator } from './src/sync';

const fields = [['placa','Placa'],['bruto','Peso bruto (kg)'],['tara','Tara (kg)'],['booking_id','Agendamento UUID (opcional)'],['motorista_nome','Motorista (opcional)'],['motorista_documento','Documento (opcional)'],['observacoes','Observações (opcional)']] as const;
const empty = { placa: '', bruto: '', tara: '', booking_id: '', motorista_nome: '', motorista_documento: '', observacoes: '' };
export default function App() {
  const [form, setForm] = useState(empty), [photo, setPhoto] = useState<Picker.ImagePickerAsset>(), [rows, setRows] = useState<Row[]>([]);
  const [url, setUrl] = useState(process.env.EXPO_PUBLIC_API_URL ?? ''), [message, setMessage] = useState('Inicializando armazenamento…'), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const runtime = useRef<{ repo: Repository; sync: SyncCoordinator } | null>(null), configured = useRef('');
  const saving = useRef(false);
  useEffect(() => {
    let alive = true, offNetwork = () => {}, offState = () => {};
    const refresh = () => { void runtime.current?.repo.list().then(value => { if (alive) setRows(value); }).catch(() => { if (alive) setMessage('Erro ao ler armazenamento.'); }); };
    void (async () => {
      const repo = await openRepository();
      configured.current = await repo.setting('api_url') ?? process.env.EXPO_PUBLIC_API_URL ?? '';
      if (!alive) return;
      setUrl(configured.current);
      const sync = new SyncCoordinator(repo, transport(() => configured.current), refresh, Date.now, () => AppState.currentState === 'active');
      runtime.current = { repo, sync };
      const trigger = () => { if (AppState.currentState === 'active' && configured.current) void sync.trigger().catch(() => setMessage('Erro no armazenamento da fila. Reinicie e procure suporte.')); };
      offNetwork = NetInfo.addEventListener(state => { if (state.isConnected === true && state.isInternetReachable !== false) trigger(); });
      const subscription = AppState.addEventListener('change', state => { if (state === 'active') trigger(); });
      offState = () => subscription.remove();
      refresh(); setReady(true); setMessage('Pronto para registrar offline.'); trigger();
    })().catch(() => { if (alive) setMessage('Não foi possível abrir o banco local. Procure suporte; dados preservados.'); });
    return () => { alive = false; offNetwork(); offState(); };
  }, []);
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
    <Text style={styles.title}>Conexão ao Gateway</Text><TextInput accessibilityLabel="URL do Gateway" autoCapitalize="none" style={styles.input} value={url} onChangeText={setUrl} />
    <Button title="Salvar URL" disabled={!ready} onPress={() => { void (async () => { try { const value = apiUrl(url); await runtime.current!.repo.setSetting('api_url', value); configured.current = value; setUrl(value); setMessage('URL salva. Autenticação real depende da integração.'); } catch { Alert.alert('URL inválida', 'Informe endereço HTTP(S) do Gateway.'); } })(); }} />
    <Button title="Sincronizar agora" disabled={!ready} onPress={() => { if (!configured.current) { setMessage('Configure a URL do Gateway.'); return; } void runtime.current?.sync.trigger().catch(() => setMessage('Falha de armazenamento durante sync.')); }} />
    <Text>Sincronização em primeiro plano. Pendências com backoff aguardam o próximo evento após o prazo; erros bloqueados exigem suporte.</Text>
    <Text style={styles.title}>Fila e histórico ({rows.length})</Text>
    {rows.map(r => <View key={r.payload.local_id} style={styles.card}><Text style={styles.bold}>{r.payload.placa} • {r.payload.peso_liquido_kg} kg • {r.status}</Text><Text selectable>{r.payload.local_id}</Text><Text>Tentativas: {r.attempts} {r.auto_retry_blocked ? '• automático bloqueado' : ''}</Text>{r.last_error && <Text>{r.last_error}</Text>}{r.next_attempt_at > 0 && r.status === 'PENDING' && <Text>Próxima tentativa elegível: {new Date(r.next_attempt_at).toLocaleString()}</Text>}{r.sequence && <Text>Confirmação #{r.sequence} • {r.received_at}</Text>}<Image source={{uri:r.photo.uri}} style={styles.thumbnail} /></View>)}
  </ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: '#f4f6ef' }, content: { padding: 20, gap: 12 }, title: { fontSize: 23, fontWeight: '700', color: '#234c32', marginTop: 16 }, input: { borderWidth: 1, borderColor: '#6c7e70', backgroundColor: 'white', borderRadius: 7, padding: 12, color: '#162b1c' }, preview: { height: 200, resizeMode: 'contain' }, thumbnail: { width: 100, height: 75, resizeMode: 'contain' }, card: { backgroundColor: 'white', padding: 14, borderRadius: 8, gap: 6 }, bold: { fontWeight: '700' } });
