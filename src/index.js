
/**
 * Google Authenticator uses protobuff to encode the 2fa data.
 *
 * @param {Uint8Array} payload
 */
function decodeProtobuf(payload) {
  const protobuf = require("protobufjs");

  const root = protobuf.loadSync("./src/google_auth.proto");

  const MigrationPayload = root.lookupType("googleauth.MigrationPayload");

  const message = MigrationPayload.decode(payload);

  return MigrationPayload.toObject(message, {
    longs: String,
    enums: String,
    bytes: String,
  })
}

/**
 * Convert a base64 to base32.
 * Most Time based One Time Password (TOTP)
 * password managers use this as the "secret key" when generating a code.
 *
 * An example is: https://totp.danhersam.com/.
 *
 * @returns RFC3548 compliant base32 string
 */
function toBase32(base64String) {
  const base32 = require('./edbase32');
  const raw = Buffer.from(base64String, "base64");
  return base32.encode(raw);
}

/**
 * The data in the URI from Google Authenticator
 *  is a protobuff payload which is Base64 encoded and then URI encoded.
 * This function decodes those, and then decodes the protobuf data contained inside.
 *
 * @param {String} data the `data` query parameter from the totp migration string that google authenticator outputs.
 */
function decode(data) {
  const buffer = Buffer.from(decodeURIComponent(data), "base64");

  const payload = decodeProtobuf(buffer);

  if (payload.version != "1") {
    console.error(`Expected payload version 1, but was ${payload.version}! Please comment your payload version (which is ${payload.version}), Google Authenticator app version and how many 2FA codes you exported in https://github.com/krissrex/google-authenticator-exporter/issues/23 .`)
  }

  const accounts = payload.otpParameters.map(account => {
    account.totpSecret = toBase32(account.secret);
    return account;
  })

  return accounts;
}

/**
 * Write the json with account information to a file
 * so it can be uploaded to other password managers etc easily.
 *
 * @param {String} data A `JSON.stringify`ed list of accounts.
 */
function saveToFile(filename, data) {
  const fs = require("fs");
  if (fs.existsSync(filename)) {
    return console.error(`File "${filename}" exists!`);
  }

  fs.writeFileSync(filename, data);
}

/**
 * Generate qrcodes from the accounts that can be scanned with an authenticator app
 * @param accounts A list of the auth accounts
 */
function saveToQRCodes(accounts){

  const QRCode = require('qrcode')
  const fs = require("fs");

  const directory = "./qrCodes"
  if(!fs.existsSync(directory)){
    fs.mkdirSync(directory)
  }

  /** Windows is picky with filenames. */
  const sanitizeFilename = (filename) => filename.replace(/[\<>:"\/\\|?*#%&{}$+!`'=@]/g, "")
  
  accounts.forEach(account => {
    const name = account.name || ""
    const issuer = account.issuer || ""
    const secret = account.totpSecret

    const url = `otpauth://totp/${encodeURI(name)}?secret=${encodeURI(secret)}&issuer=${encodeURI(issuer)}`
    const file = `${directory}/${issuer || "No issuer"} (${sanitizeFilename(name)}).png`

    if(fs.existsSync(file)) {
      console.log(`${file.yellow} already exists.`)
    }else{
      QRCode.toFile(file, url, (error) => {
        if(error != null){
          console.log(`Something went wrong while creating ${file}`, error)
        }
        console.log(`${file.green} created.`)
      })
    }

  })
}

/**
 * Saves to json if the user said yes.
 * @param promptResult The results from the promt given to the user.
 * @param accounts A list of the auth accounts.
 */
function toJson(filename, saveToFileInput, accounts) {
  console.log(filename)
  console.log(saveToFileInput)

  if (saveToFileInput && filename) {
    console.log(`Saving to "${filename}"...`);
    saveToFile(filename, JSON.stringify(accounts, undefined, 4));
  } else {
    console.log("Not saving. Here is the data:");
    console.log(accounts);
    console.log("What you want to use as secret key in other password managers is ".yellow + "'totpSecret'".blue + ", not 'secret'!".yellow);
  }
}

/**
 * @param {string} uri The raw QR code uri
 * @returns decoded data with account info
 */
function decodeExportUri(uri) {
  const queryParams = new URL(uri).search;
  const data = new URLSearchParams(queryParams).get("data");

  return decode(data);
}

/**
 * Act as a CLI and ask for `otpauth-migration://` uri and optionally file to store in.
 */
function promptUserForUri() {
  let prompt;
  try {
    prompt = require("prompt");
    const qr = require("qrcode-reader");
    const Jimp = require("jimp");
  } catch(ex) {
    console.error("Error! Missing dependencies:")
    console.error("You need to first run: npm install");
    process.exit(1);
  }
  
  console.log("Enter the URI from Google Authenticator QR code.")
  console.log("The URI looks like otpauth-migration://offline?data=... \n")

  console.log("You can get it by exporting from Google Authenticator app, then scanning the QR with");
  console.log("e.g. https://play.google.com/store/apps/details?id=com.google.zxing.client.android")
  console.log("and copying the text to your pc, e.g. with Google Keep ( https://keep.google.com/ )")

  require("colors");
  console.log("By using online QR decoders or untrusted ways of transferring the URI text,".red)
  console.log("you risk someone storing the QR code or URI text and stealing your 2FA codes!".red)
  console.log("Remember that the data contains the website, your email and the 2FA code!".red)

  console.log("You can now directly pass an image file containing the QR code using the `-i` option.")

  const resultType = {
    QRCODE: "qrcode",
    JSON: "json",
    IMAGE: "image",
  }

  const mode = process.argv.includes('-q') ? resultType.QRCODE : 
    process.argv.includes('-i') ? "image" : resultType.JSON

  const promptVariables = ["totpUri"]

  if(mode === resultType.JSON){
    promptVariables.push("saveToFile")
    promptVariables.push("filename")
  } else if (mode === resultType.IMAGE) {
    promptVariables.push("imagePath")
  }

  prompt.start();
  prompt.get(promptVariables, (err, result) => {
    if (err) { return console.error(err); }

    let accounts;
    if (mode === resultType.IMAGE) {
      Jimp.read(fs.readFileSync(result.imagePath), function(err, image) {
        if (err) { return console.error(err); }
        const qrCode = new qr();
        qrCode.callback = function(err, value) {
          if (err) { return console.error(err); }
          accounts = decodeExportUri(value.result);
          
          switch(mode){
            case resultType.QRCODE:
              saveToQRCodes(accounts)
              break
            case resultType.JSON:
              const saveToFileInput = result.saveToFile.toLowerCase().startsWith("y")
              toJson(result.filename, saveToFileInput, accounts);
              break
            case resultType.IMAGE:
              saveToQRCodes(accounts)
              break
          }
        };
        qrCode.decode(image.bitmap);
      });
    } else {
      const uri = result.totpUri;
      accounts = decodeExportUri(uri);

      switch(mode){
        case resultType.QRCODE:
          saveToQRCodes(accounts)
          break
        case resultType.JSON:
          const saveToFileInput = result.saveToFile.toLowerCase().startsWith("y")
          toJson(result.filename, saveToFileInput, accounts);
          break
      }
    }
  })
}

exports.decodeExportUri = decodeExportUri;

if (require.main === module) {
  // Wont run inside tests where this file is just imported
  promptUserForUri();
}
