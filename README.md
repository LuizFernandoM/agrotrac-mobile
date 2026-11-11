# AgroTrac Mobile — Aplicativo de Campo (Offline-First)

Aplicativo móvel para operadores de balança e motoristas do sistema **AgroTrac**, em estrita conformidade com a especificação original (`acac36b6`) e a **Opção 1 aprovada** (pesagem offline + anexo direto de romaneio).

---

## 1. Responsabilidades

- **Operação de Campo Offline-First**: Permite que o operador de balança registre o peso da carga do caminhão mesmo em locais remotos sem cobertura de internet.
- **Acesso a Recurso Nativo**: Captura ou anexo de fotos do romaneio de carga em papel utilizando a câmera/galeria via `expo-image-picker`.
- **Persistência Local Persistente**: Salva os dados estruturados da pesagem em banco SQLite local e mantém o arquivo de imagem salvo no sistema de arquivos do aparelho.
- **Sincronização Idempotente**: Ao restabelecer sinal de rede, executa automaticamente rotina de envio das pesagens pendentes via `multipart/form-data` para a API Gateway / Audit C.
- **Prevenção de Duplicatas**: Utiliza chave única (`local_id` UUID) gerada no momento da pesagem para garantir que reenvios ou instabilidades de conexão nunca dupliquem registros no servidor.

---

## 2. Ferramentas e Tecnologias

- **Plataforma Mobile**: React Native com Expo e TypeScript.
- **Banco Local Offline**: SQLite (`expo-sqlite`).
- **Recurso Nativo (Foto)**: `expo-image-picker` e `expo-file-system`.
- **Detecção de Conectividade**: `@react-native-community/netinfo`.
- **Cliente HTTP**: Axios ou Fetch API para envio `multipart/form-data`.

---

## 3. Arquitetura de Pastas

```text
agrotrac-mobile/
├── src/
│   ├── screens/                 # Telas do aplicativo
│   │   ├── WeighingScreen.tsx   # Formulário de pesagem (placa, peso, motorista)
│   │   ├── CameraScreen.tsx     # Captura / anexo da foto do romaneio
│   │   └── SyncStatusScreen.tsx # Fila de sincronização e status local
│   ├── database/                # Persistência local SQLite
│   │   ├── db.ts                # Conexão e inicialização do SQLite
│   │   └── weighingRepository.ts # CRUD local (salvar, listar pendentes, marcar sincronizado)
│   ├── services/                # Serviços de rede
│   │   ├── api.ts               # Cliente HTTP
│   │   └── syncService.ts       # Rotina de detecção de conexão e upload multipart
│   ├── types/                   # Tipos de dados (Weighing, SyncStatus)
│   └── App.tsx                  # Ponto de entrada do aplicativo
├── app.json
├── package.json
└── tsconfig.json
```

---

## 4. Conexões e Integrações

- **Sem Internet**: Funciona de forma totalmente autônoma, gravando pesagens no banco local SQLite com status `PENDING`.
- **Com Internet**: Dispara envio HTTP para o **API Gateway**:
  - `POST /v1/audit/weighings/sync`: Envio `multipart/form-data` contendo o payload da pesagem (`local_id`, `placa`, `peso_bruto_kg`, `tara_kg`, `peso_liquido_kg`) junto com o arquivo de imagem do romaneio.
  - Ao receber confirmação do servidor (`201 Created` ou `200 OK`), atualiza o status local para `SYNCED`.
