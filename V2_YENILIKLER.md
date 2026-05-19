# MakroSOFT Secure Notes V2

Bu sürümde eklenen/hazırlanan başlıca özellikler:

- Şifreli kitap uygulama ikonu ve launcher icon dosyaları
- Şifre üretici
- Şifre güvenlik puanı
- Kopyalanan şifreyi 30 saniye sonra clipboard'dan temizleme
- Yaşlı kullanıcı modu
- Biyometrik giriş hazırlık ekranı
- V2 güvenlik bilgilendirme alanı
- APK debug/release komutları

## Kurulum

```bash
npm install
npm run build
npx cap sync android
npx cap open android
```

## APK alma

```bash
npm run android:debug
```

veya Android Studio'da Build > Build APK.

## Not

Gerçek parmak izi / Face ID için native cihazda `capacitor-native-biometric` plugini aktif edilmelidir. Bu paket V2 arayüzünü ve altyapı hazırlığını içerir.
