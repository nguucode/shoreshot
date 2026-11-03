# ShoreShot

App chụp màn hình + chú thích cho **macOS và Windows** (Electron + TypeScript). Chạy nền ở thanh menu (macOS) / khay hệ thống (Windows).

## Tính năng

| Nhóm | Chi tiết |
|---|---|
| Chụp | Phím tắt toàn cục, mặc định `⌘⇧X` (macOS) / `Ctrl+Shift+X` (Windows), **đổi được** trong Cài đặt. Kéo để chọn vùng, click 1 phát = cả màn hình. Chụp màn hình đang có con trỏ chuột. Ảnh xuất ở độ phân giải thật (Retina / HiDPI). |
| Vẽ khung | Tool `R`. Lăn chuột để đổi độ dày viền (1 đến 40px), kể cả khi đang kéo. |
| Viết chữ | Tool `T`. Click để gõ, `Enter` để xong, `Shift+Enter` xuống dòng, `Esc` huỷ. Lăn chuột để đổi cỡ chữ (10 đến 160px). Click lại vào chữ đã viết để sửa nội dung, cỡ, màu. |
| Bút tự do | Tool `P`. Nét được làm mượt. Lăn chuột để đổi độ dày nét. |
| Màu | 8 màu sẵn + bảng màu tuỳ chọn. Áp dụng cho khung, chữ, bút. Đổi màu khi đang gõ chữ thì chữ đổi màu ngay. |
| Xuất | `⌘/Ctrl+C`: copy vào clipboard. `⌘/Ctrl+S`: lưu PNG (mặc định vào Pictures). |
| Copy + tự dán | `⌘V` / `Ctrl+V`: copy rồi tự dán thẳng vào app đang dùng trước khi chụp (Slack, Telegram, Figma…). Trong Cài đặt có thể đặt `Enter` / nút ✓ làm việc này thay cho copy thường. |
| Khác | `Enter` / nút ✓: copy (hoặc copy + dán, tuỳ cài đặt). `⌘/Ctrl+Z` undo, `⌘/Ctrl+Shift+Z` hoặc `Ctrl+Y` redo, `Esc` thoát. Chuột phải khi chưa vẽ = chọn lại vùng. Menu tray có "Khởi động cùng máy". |

Lăn chuột lên = to hơn, lăn xuống = nhỏ hơn. Trackpad được cộng dồn để không nhảy quá nhanh.

## Cài đặt

### Cách 1: một dòng lệnh

**macOS** (mở Terminal):
```bash
curl -fsSL https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.sh | bash
```

**Windows** (mở PowerShell, không cần quyền Admin):
```powershell
irm https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.ps1 | iex
```

Script tải bản build mới nhất trong [Releases](https://github.com/nguucode/shoreshot/releases), cài rồi mở app.

| Việc | macOS | Windows |
|---|---|---|
| Cài vào | `/Applications` (không ghi được thì `~/Applications`) | `%LOCALAPPDATA%\Programs\ShoreShot` |
| Gỡ | `... \| bash -s -- --uninstall` | `& ([scriptblock]::Create((irm <url>))) -Uninstall` |

Chạy lại lệnh cài là cập nhật lên bản mới nhất.

### Cách 2: tải file cài

Vào [Releases](https://github.com/nguucode/shoreshot/releases/latest), tải:
- Mac Apple Silicon (M1 trở lên): `ShoreShot-x.y.z-mac-arm64.dmg`
- Mac Intel: `ShoreShot-x.y.z-mac-x64.dmg`
- Windows: `ShoreShot-Setup-x.y.z.exe`

App chưa ký số (code signing):
- **macOS** báo "is damaged" hoặc "cannot be opened": chạy `xattr -cr /Applications/ShoreShot.app` rồi mở lại. (Cài bằng Cách 1 thì không gặp lỗi này.)
- **Windows** SmartScreen cảnh báo: bấm More info > Run anyway.

### macOS: quyền cần cấp

- **Screen Recording**: lần chụp đầu macOS sẽ hỏi. Bật ShoreShot trong System Settings > Privacy & Security > Screen & System Audio Recording, rồi thoát hẳn và mở lại app.
- **Accessibility**: chỉ cần nếu dùng `⌘V` tự dán vào app khác.

## Phát triển

Cần Node.js 18+.

```bash
git clone https://github.com/nguucode/shoreshot.git && cd shoreshot
npm install
npm start          # chạy dev (macOS: cấp quyền Screen Recording cho app "Electron")
npm run dist:mac   # build .dmg + .zip trên Mac
npm run dist:win   # build .exe trên Windows
```

### Phát hành bản mới

Tăng `version` trong `package.json`, commit, rồi chọn một trong hai:
- Trên GitHub: tab **Actions** > **build** > **Run workflow** > tick **release** > Run.
- Hoặc terminal: `git tag v0.1.1 && git push origin v0.1.1`

GitHub Actions (`.github/workflows/build.yml`) build trên macOS + Windows rồi tự tạo Release kèm file `.dmg`, `.zip`, `.exe`. Script cài đặt luôn lấy release mới nhất.

## Đổi phím tắt

Icon trên thanh menu/khay > **Đổi phím tắt…** > bấm vào ô > nhấn tổ hợp mới. App đăng ký ngay; nếu tổ hợp đã bị hệ thống hoặc app khác giữ thì báo lỗi và giữ phím cũ. Cần ít nhất 1 phím bổ trợ, trừ `F1` đến `F24` và `PrintScreen`. Nút **Mặc định** trả về `⌘⇧X` / `Ctrl+Shift+X`.

Cấu hình lưu ở `config.json` trong thư mục userData (macOS: `~/Library/Application Support/ShoreShot/`, Windows: `%APPDATA%\ShoreShot\`). Nếu lúc khởi động phím đã lưu bị app khác chiếm, cửa sổ Cài đặt tự mở.

Lưu ý Windows 11: phím `PrintScreen` thường đã gán cho Snipping Tool. Muốn dùng thì tắt ở Settings > Accessibility > Keyboard > "Use the Print screen key to open screen capture".

## Copy + tự dán: quyền cần có

- **macOS**: cần quyền **Accessibility** để gửi phím ⌘V (System Settings > Privacy & Security > Accessibility). Lần đầu macOS có thể hỏi thêm "ShoreShot muốn điều khiển System Events", bấm OK. Chưa có quyền thì ảnh vẫn được copy và app báo để sếp tự bấm ⌘V.
- **Windows**: không cần quyền gì. App gửi Ctrl+V qua PowerShell, nên có độ trễ khoảng nửa giây. Không dán được vào app chạy quyền Administrator khi ShoreShot chạy quyền thường (giới hạn của Windows).
- Bấm `⌘V` / `Ctrl+V` thì app đợi sếp nhả hết phím mới gửi phím dán, để phím đang giữ không lẫn vào (ví dụ thành `Ctrl+Shift+V`, dán không định dạng).

## Cấu trúc

```
src/main.ts              process chính: tray, phím tắt + config, chụp, clipboard, tự dán, lưu file
src/preload.ts           cầu nối IPC an toàn (contextIsolation + sandbox)
src/renderer/editor.ts   overlay chọn vùng + vẽ chú thích (canvas)
src/renderer/settings.ts cửa sổ Cài đặt: ghi phím tắt, hành động của Enter
static/                  HTML/CSS cho overlay và Cài đặt
scripts/install.sh|.ps1  cài/gỡ bằng terminal (macOS/Windows)
assets/                  icon tray
build/icon.png           icon app (electron-builder tự convert sang .icns/.ico)
```

## Giới hạn hiện tại

- Mỗi lần chụp 1 màn hình (màn hình có con trỏ). Chưa chọn vùng vắt qua 2 màn hình.
- Chưa kéo/resize lại vùng chọn sau khi đã vẽ (chuột phải khi chưa vẽ để chọn lại).
- Chưa chọn và di chuyển shape đã vẽ (riêng chữ thì click để sửa được).
