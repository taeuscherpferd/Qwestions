# Qwestions

Qwestions is a small classroom response app. The teacher runs the server on an iPad, students join from a QR code in their browser, and answers are saved on the iPad. It supports multiple choice and written answers, one open question at a time, saved classes, and CSV export.

## Run it on an iPad with iSH

1. Install **iSH Shell** and open it.
2. Install Node and npm in iSH:

   ```sh
   apk update
   apk add nodejs npm
   ```

3. Copy this project folder into iSH. To make an iSH folder visible in the Files app, open **Files → Edit → turn on iSH**; then copy the project folder there. Move into the folder in iSH, install the QR-code package, and start the server:

   ```sh
   cd qwestions
   npm install
   npm start
   ```

   The terminal prints the host key when the server starts. Enter it in the teacher page when prompted. The key is saved in `data/admin-key.txt`; the teacher browser remembers it after that.

4. Keep iSH open while the class is using Qwestions. iPadOS may pause the server when iSH goes into the background.
5. On the iPad, open `http://localhost:3000` to manage questions. In **iPad address on this Wi-Fi**, enter `http://<iPad-Wi-Fi-address>:3000`, using the IP address shown in **Settings → Wi-Fi → ⓘ** (for example, `http://192.168.1.23:3000`). The QR code updates to use that address. You can also open that address directly on the iPad instead of `localhost`.
6. Students scan the QR code with their camera. They do not need an account or an app.

If iOS asks whether iSH can use the local network, allow it. The iPad and student devices need to be on the same Wi-Fi network, and that network must allow devices to connect to each other. School guest Wi-Fi sometimes blocks that traffic.

### iSH cannot detect the Wi-Fi address

Some iSH versions throw `uv_interface_addresses` / `ERR_SYSTEM_ERROR` when Node tries to list network interfaces. Qwestions treats this as unavailable address detection and keeps serving questions and responses. Open `http://localhost:3000` and enter the Wi-Fi address manually as described above. You do not need to change `HOST`; the server already listens on all network interfaces.

## Use it

- Add questions before or during class. For multiple choice, put one option on each line.
- Press **Open** beside a question to show it to students. Only one question is open at a time.
- Students enter their name once per class. They can edit their answer until the teacher closes the question.
- Use **Download responses CSV** to keep a copy in Numbers, Excel, or Sheets.
- **New class** saves the current class and creates a fresh one. Older classes remain available in the class menu.

The server stores everything in `data/store.json`. Keep a copy of that file if you want a backup. Students do not need accounts. Qwestions uses plain HTTP, so use it on a trusted local network.

## Run on another computer

Install Node.js 16 or newer, then run `npm install` and `npm start` in this folder. Open `http://<computer-Wi-Fi-address>:3000` on the teacher device. The server listens on all network interfaces by default; set `PORT` to use another port.
