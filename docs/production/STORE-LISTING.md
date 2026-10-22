# Chrome Web Store listing materials

Name: ClearScroll

Short description (also in manifest): Best-effort blurring of webpage text about topics you choose, with local AI. Reveal items or pause filtering anytime.

Category suggestion: Productivity. Language: English. Single purpose: user-controlled local topic blurring of webpage text.

## English description

Choose topics you would rather see less of. ClearScroll uses an on-device AI model to blur related webpage text while you browse.

• Add your own topics; nothing is filtered until you configure an enabled topic.
• Choose Precise, Balanced or Thorough filtering.
• Reveal a blurred item with a click or keyboard. Pause whenever you want.
• Exclude websites and add literal exceptions for individual topics.
• Keep optional feedback locally, export it yourself, or delete it.

Text inference runs locally, with CPU fallback and supported GPU acceleration. No external AI service, account, telemetry or browsing-data upload is used. The model is included in the package.

Filtering is best-effort: related content can be missed and unrelated content can be blurred. English works best. Content may appear before it is checked. ClearScroll is not a guaranteed spoiler blocker, parental control or complete harmful-content protection system.

This release filters text, not image pixels, audio or video. Text matches may blur a whole card including its thumbnail. YouTube video and Shorts filtering is unsupported: previews may escape blurring. YouTube is visibly excluded on new installs; removing the rule enables experimental behavior. Browser pages, Chrome Web Store pages, PDFs and embedded frames are unsupported.

Open Settings for a short getting-started guide and offline Help and privacy. Website access is used only to process and blur text on enabled sites. Review the privacy policy before installation.

## Optional Turkish description

Görmek istemediğiniz konuları seçin. ClearScroll, cihazınızda çalışan bir yapay zekâ modeliyle ilgili web sayfası metinlerini bulanıklaştırır. Bir konu ekleyip kaydetmeden filtreleme başlamaz. Precise, Balanced ve Thorough modlarından birini seçebilir; içeriği tıklayarak veya klavyeyle gösterebilir, filtrelemeyi duraklatabilir ve siteleri hariç tutabilirsiniz.

Metin analizi yereldir; dış yapay zekâ hizmeti, telemetri veya gezinme verisi yüklemesi kullanılmaz. İngilizce metinlerde daha iyi çalışır. Filtreleme hatasız değildir: ilgili içerik kaçabilir, ilgisiz içerik gizlenebilir. Garantili spoiler engelleyici, ebeveyn denetimi veya eksiksiz güvenlik sistemi değildir.

Bu sürüm görüntü piksellerini, sesi veya videoyu sınıflandırmaz. YouTube video/Shorts önizlemeleri desteklenmez; yeni kurulumlarda YouTube görünür site kurallarıyla hariç tutulur. Bu kuralları kaldırmak deneysel davranışı etkinleştirir. Ayarlar ve yardım arayüzü İngilizcedir.

## Upload preparation

Use the final verified 1280×800 real UI screenshots under build/040-production-readiness/screenshots (or final Chrome capture subdirectory). They show a clearly labeled local synthetic demo, not a publisher's page or a claim of universal accuracy. The existing brand is rendered with transparent padding in store-assets/store-icon-128.png (128×128). store-assets/small-promo-440x280.png is the required small promotional tile, explicitly a brand graphic rather than a UI screenshot. Reproduce both with node scripts/render-store-assets.mjs. No invented features or private browsing content. Do not upload preliminary screenshots if the final UI changed.

Publisher must supply their verified identity/contact, privacy URL, support URL, distribution territories and dashboard certifications. No publisher registration or submission was performed. Source recovery/synchronization is required before using repository documentation links as the current release reference.
