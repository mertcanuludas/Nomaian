# Nomaian

Mesajlarını, molekül çizimlerini andıran parlak spiral yazılara dönüştüren ve bu yazıları telefon kamerasıyla geri okuyan bir web uygulaması.

> Outer Wilds oyunundaki Nomai yazısından esinlenen, **resmi olmayan bir hayran projesidir**. Mobius Digital ya da Annapurna Interactive ile hiçbir bağlantısı yoktur ve onlar tarafından desteklenmemektedir. Oyunla ilgili adlar ve kavramlar sahiplerine aittir.

## Neler yapabilir?

**Yaz**
- Her mesaj kendi spiraline yazılır. Cevaplar, cevap verdikleri mesajın spiralinden dallanarak bir konuşma ağacı oluşturur.
- Bir mesaj en fazla 100 bayt olabilir (yazar adı dahil); bir mesaja en fazla 3 cevap verilebilir.
- Spiraller mesajın uzunluğundan bağımsız olarak hep benzer boyuttadır; kısa bir mesaj spiralini dolduracak kadar tekrar tekrar yazılır.
- Arka plan: bordo, mor ya da sarı tuğla duvar, düz beyaz veya saydam.
- Yazı rengi: mavi, beyaz ya da turuncu (her mesaja ayrı); hepsi birden siyah da yapılabilir.
- Sonuç PNG olarak indirilebilir ya da paylaşılabilir.

**Oku**
- Kamerayı yazının üzerinde gezdirerek okuma: spiralin tamamının kadraja girmesi gerekmez, yakından görülen parçalar birleştirilir.
- Kayıtlı bir fotoğraftan okuma.
- Eğik çekilmiş, döndürülmüş, bulanık ya da silindir gibi kavisli bir yüzeye basılmış yazılar da okunabilir.

## Gizlilik

Her şey tarayıcının içinde çalışır. Kamera görüntüsü ve fotoğraflar hiçbir sunucuya gönderilmez; yazdığın konuşma yalnızca tarayıcının kendi deposunda (localStorage) tutulur. Uygulama hiçbir ağ isteği yapmaz.

## Çalıştırma

Gerekenler: [Node.js](https://nodejs.org/) 20.19 / 22.12 veya üstü (uzun destekli bir sürüm önerilir).

```sh
git clone https://github.com/mertcanuludas/Nomaian.git
cd Nomaian
npm install
npm run dev
```

Geliştirme sunucusu `https://localhost:5173` (sertifika yoksa `http://`) adresinde açılır ve yerel ağa da açıktır (`--host`).

### Telefonda kamera için HTTPS

Tarayıcılar kamerayı yalnızca güvenli (HTTPS) sayfalarda açar. Telefondan yerel ağ üzerinden denemek için kendi bilgisayarına özel bir sertifika üret; `.cert/` klasöründe durur ve depoya **eklenmez**:

```sh
mkdir .cert
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout .cert/dev-key.pem -out .cert/dev.pem \
  -subj "/CN=Nomaian dev" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<yerel IP adresin>"
```

Kendi ürettiğin sertifika olduğu için tarayıcı ilk açılışta uyarı verir; güvendiğin kendi bilgisayarın olduğu için devam edebilirsin.

### Yayınlama

```sh
npm run build
```

`dist/` klasörü düz statik dosyalardan oluşur ve herhangi bir alt yoldan çalışır; GitHub Pages, Netlify gibi statik barındırma servislerine olduğu gibi konabilir. GitHub Pages'te yayınlandığında adres `https://mertcanuludas.github.io/Nomaian/` olur.

## Testler ve araçlar

```sh
npm test          # birim ve görüntü testleri (birkaç dakika sürebilir)
npm run typecheck # tip denetimi
```

Görüntü testleri yazıyı çizip, fotoğraf benzetimiyle (eğim, bulanıklık, gürültü, JPEG, silindir yüzey, parça parça tarama) bozup geri okur. Ürettikleri görüntüler `tests/out/` klasörüne yazılır.

`scripts/` klasöründe geliştirme sırasında kullanılan araçlar var; her biri `npx vite-node scripts/<ad>.ts` ile çalışır:

| Betik | Ne yapar |
|---|---|
| `preview.ts` | Örnek bir konuşmayı çizer |
| `themes.ts` | Bütün arka plan ve yazı rengi birleşimlerini çizer |
| `shapes.ts` | Spiral kıvrım çeşitlerini yan yana çizer |
| `diagnose.ts` | Bir çizimi okur ve okuyucunun her adımını gerçek çizimle karşılaştırır |
| `diagnose-photo.ts` | Gerçek bir fotoğrafta okuyucunun ne bulduğunu gösterir |
| `links.ts` | Eğik bir fotoğrafta işaretler arası bağlantıları tek tek denetler |
| `crop.ts` | Bir görüntüden yakın plan kesit alır |

## Nasıl çalışır?

- **Yazı:** Düzensiz, spiralin ekseni etrafında dalgalanan bir zikzak zincir. Her köşeden, 16 çeşitten biri olan bir şekil (halka, kaynaşık halkalar, çatal, dal…) çıkar ve 4 bit taşır; köşeler arasındaki her bağ düz ya da ortasından kırıktır ve 1 bit taşır.
- **İşaretler:** Zincirde düzenli aralıklarla duran kaynaşık iki altıgen. Okuyucu bunları görüntünün herhangi bir yerinde, herhangi bir açıda bulur ve aralarındaki yazıyı okur.
- **Parçalar:** Mesaj, her biri üç işaret aralığına yazılan parçalara bölünür. Her parça kendi başına bir Reed–Solomon kod sözcüğüdür; hangi mesajın kaçıncı parçası olduğunu söyler ve okuma hatalarını düzeltir. Bu sayede bir spiral parça parça okunabilir.
- **Bütünlük:** Parçalar birleştirildikten sonra mesajın CRC sağlaması denetlenir; yanlış birleştirilmiş bir mesaj kabul edilmez.

Kaynak kod:

| Dosya | İçerik |
|---|---|
| `src/core/layout.ts` | Yazının ve spirallerin geometrisi, konuşmanın yerleşimi |
| `src/core/shapes.ts` | Şekiller, çizim ve okuyucunun şablonları |
| `src/core/encode.ts` | Mesajı parçalara ve sembollere çevirme |
| `src/core/decode.ts` | Görüntüden okuma ve parçaları birleştirme |
| `src/core/detect.ts` | Görüntü hazırlama ve işaret bulma |
| `src/core/render.ts` | Renkler, tuğla duvar ve çizim |
| `src/core/rs.ts`, `bits.ts`, `textcodec.ts`, `homography.ts` | Hata düzeltme, bit işlemleri, metin sıkıştırma, perspektif |
| `src/main.ts` | Arayüz |
| `src/worker.ts`, `src/layout-worker.ts` | Arka planda okuma ve konuşmanın yerleşimi |

## Lisans

Kod [MIT lisansı](LICENSE) ile yayınlanmıştır. Lisans yalnızca bu depodaki kodu kapsar; Outer Wilds'a ait adlar, kavramlar ve görsel dünya sahiplerine aittir.
