import type { ConfigContext, ExpoConfig } from 'expo/config';
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'AgroTrac', slug: 'agrotrac-mobile', version: '0.1.0', orientation: 'portrait',
  android: { package: 'br.com.agrotrac.mobile' },
  plugins: [
    ['expo-image-picker', { cameraPermission: 'Fotografar o romaneio da pesagem.', photosPermission: 'Selecionar foto do romaneio.', microphonePermission: false }],
    'expo-sqlite',
    ['expo-build-properties', { android: { usesCleartextTraffic: process.env.AGROTRAC_DEV_CLEARTEXT === '1' && process.env.NODE_ENV !== 'production' } }],
  ],
});
