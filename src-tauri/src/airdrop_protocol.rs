//! AirDrop application-layer wire codecs (no radio or HTTP server here).
//!
//! The field names and request flow follow OpenDrop's protocol-compatible
//! implementation and current Omdrop's sender/receiver. No OpenDrop GPL source
//! is copied into this module; these are independently written codecs for the
//! documented/captured wire formats. The radio backend must still supply an
//! AWDL IPv6 interface before any of these bytes can reach an Apple device.

use flate2::read::{GzDecoder, ZlibDecoder};
use flate2::write::{GzEncoder, ZlibEncoder};
use flate2::Compression;
use plist::Value;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const DISCOVER_PATH: &str = "/Discover";
pub const ASK_PATH: &str = "/Ask";
pub const UPLOAD_PATH: &str = "/Upload";
pub const OPEN_DROP_CONTENT_TYPE: &str = "application/x-cpio";
pub const OMDROP_CONTENT_TYPE: &str = "application/x-dvzip";
pub const MAX_FILES: usize = 64;
pub const MAX_METADATA_BYTES: usize = 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_TRANSFER_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = MAX_TRANSFER_BYTES + (MAX_FILES as u64 * 512);
const MAX_NAME_BYTES: usize = 255;
const DVZIP_BLOCK_BYTES: usize = 64 * 1024;
const COPY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireProfile {
    /// OpenDrop's older file transfer profile: x-cpio carrying gzip-cpio.
    OpenDrop,
    /// Current Omdrop profile: modern plist fields and DVZip-framed cpio.
    Omdrop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SenderIdentity {
    pub computer_name: String,
    pub model_name: String,
    pub service_id: String,
    pub bundle_id: String,
    pub record_data: Option<Vec<u8>>,
    pub identity_auth_tag: Option<[u8; 3]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiverIdentity {
    pub computer_name: String,
    pub model_name: String,
    /// This is JSON bytes carried as a plist data value in current Omdrop.
    pub media_capabilities_json: Vec<u8>,
    pub record_data: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiverDescription {
    pub computer_name: Option<String>,
    pub model_name: Option<String>,
    pub media_capabilities_json: Option<Vec<u8>>,
    pub is_airdropable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDescriptor {
    pub file_name: String,
    pub file_type: String,
    pub size: u64,
    /// OpenDrop's legacy Ask omits FileSize; zero is otherwise a real size.
    pub size_known: bool,
    pub file_bom_path: String,
    pub is_directory: bool,
}

impl FileDescriptor {
    /// Build AirDrop's per-file Ask metadata from a local regular file.
    pub fn from_path(path: &Path) -> io::Result<Self> {
        let metadata = fs::metadata(path)?;
        if !metadata.is_file() {
            return Err(invalid("AirDrop only supports regular files"));
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| invalid("file name is not valid UTF-8"))?;
        validate_file_name(name)?;
        let size = metadata.len();
        if size > MAX_FILE_BYTES {
            return Err(invalid("file exceeds the AirDrop transfer limit"));
        }
        Ok(Self {
            file_name: name.to_string(),
            file_type: uti_for_path(path).to_string(),
            size,
            size_known: true,
            file_bom_path: format!("./{name}"),
            is_directory: false,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskProposal {
    pub transfer_id: Option<String>,
    pub sender_name: Option<String>,
    pub sender_model: Option<String>,
    pub sender_id: Option<String>,
    pub files: Vec<FileDescriptor>,
}

/// Opaque capability that only `decide_ask(..., Accept)` creates. Upload
/// decoding/writing requires this value, so network input alone can never cause
/// file writes through this module.
#[derive(Debug, Clone)]
pub struct ApprovedTransfer {
    transfer_id: Option<String>,
    files: Vec<FileDescriptor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Accept,
    Reject,
}

#[derive(Debug)]
pub enum AskDecision {
    Accepted {
        response_plist: Vec<u8>,
        permit: ApprovedTransfer,
    },
    Rejected {
        http_status: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedFile {
    pub name: String,
    pub path: PathBuf,
    pub bytes: u64,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn plist_error(error: plist::Error) -> io::Error {
    invalid(format!("invalid binary property list: {error}"))
}

fn write_binary_plist(value: &Value) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    plist::to_writer_binary(&mut bytes, value).map_err(plist_error)?;
    if bytes.len() > MAX_METADATA_BYTES {
        return Err(invalid("property list exceeds metadata limit"));
    }
    Ok(bytes)
}

fn read_binary_plist(bytes: &[u8]) -> io::Result<Value> {
    if bytes.len() > MAX_METADATA_BYTES {
        return Err(invalid("property list exceeds metadata limit"));
    }
    if !bytes.starts_with(b"bplist00") {
        return Err(invalid("expected a binary property list"));
    }
    plist::from_bytes(bytes).map_err(plist_error)
}

fn dictionary(value: Value) -> io::Result<plist::Dictionary> {
    match value {
        Value::Dictionary(dict) => Ok(dict),
        _ => Err(invalid("property list root must be a dictionary")),
    }
}

fn value_string(value: Option<&Value>, field: &str) -> io::Result<Option<String>> {
    match value {
        Some(Value::String(value)) => Ok(Some(value.clone())),
        None => Ok(None),
        _ => Err(invalid(format!("{field} must be a string"))),
    }
}

/// Encode the binary plist used by current Omdrop's `/Discover` request.
/// OpenDrop historically sends only optional `SenderRecordData`; callers can
/// choose that older profile explicitly.
pub fn build_discover_request(
    profile: WireProfile,
    record_data: Option<&[u8]>,
) -> io::Result<Vec<u8>> {
    let mut body = plist::Dictionary::new();
    if let Some(data) = record_data {
        body.insert("SenderRecordData".into(), Value::Data(data.to_vec()));
    }
    if profile == WireProfile::Omdrop {
        body.insert("DeviceSupportFlags".into(), Value::Integer(111_611.into()));
    }
    write_binary_plist(&Value::Dictionary(body))
}

/// Validate a peer's binary plist response to `/Discover`.
pub fn parse_discover_response(bytes: &[u8]) -> io::Result<ReceiverDescription> {
    let dict = dictionary(read_binary_plist(bytes)?)?;
    let media = match dict.get("ReceiverMediaCapabilities") {
        Some(Value::Data(data)) => Some(data.clone()),
        Some(Value::String(data)) => Some(data.as_bytes().to_vec()),
        None => None,
        _ => return Err(invalid("ReceiverMediaCapabilities has an invalid type")),
    };
    let is_airdropable = match dict.get("IsAirDropable") {
        Some(Value::Boolean(value)) => Some(*value),
        None => None,
        _ => return Err(invalid("IsAirDropable must be a boolean")),
    };
    Ok(ReceiverDescription {
        computer_name: value_string(dict.get("ReceiverComputerName"), "ReceiverComputerName")?,
        model_name: value_string(dict.get("ReceiverModelName"), "ReceiverModelName")?,
        media_capabilities_json: media,
        is_airdropable,
    })
}

/// Create the current Omdrop/modern AirDrop `/Ask` plist. The transfer ID is
/// uppercase UUID text and must be repeated in the later `/Upload` header.
pub fn build_ask_request(
    profile: WireProfile,
    sender: &SenderIdentity,
    transfer_id: Uuid,
    files: &[FileDescriptor],
) -> io::Result<Vec<u8>> {
    validate_sender(sender)?;
    validate_descriptors(files)?;

    let mut body = plist::Dictionary::new();
    body.insert(
        "SenderComputerName".into(),
        Value::String(sender.computer_name.clone()),
    );
    body.insert(
        "SenderModelName".into(),
        Value::String(sender.model_name.clone()),
    );
    body.insert("SenderID".into(), Value::String(sender.service_id.clone()));
    body.insert("BundleID".into(), Value::String(sender.bundle_id.clone()));
    body.insert("ConvertMediaFormats".into(), Value::Boolean(false));
    body.insert(
        "Files".into(),
        Value::Array(
            files
                .iter()
                .map(|file| file_descriptor_value(file, profile))
                .collect(),
        ),
    );
    if profile == WireProfile::Omdrop {
        body.insert(
            "TransferID".into(),
            Value::Dictionary(plist::Dictionary::from_iter([(
                "id".to_string(),
                Value::String(transfer_id.hyphenated().to_string().to_uppercase()),
            )])),
        );
        body.insert(
            "TransferType".into(),
            Value::Dictionary(plist::Dictionary::from_iter([(
                "files".to_string(),
                Value::Dictionary(plist::Dictionary::new()),
            )])),
        );
        body.insert("Items".into(), Value::Array(Vec::new()));
    }
    if let Some(data) = &sender.record_data {
        body.insert("SenderRecordData".into(), Value::Data(data.clone()));
    }
    if let Some(tag) = sender.identity_auth_tag {
        body.insert("SenderIdentityAuthTag".into(), Value::Data(tag.to_vec()));
    }
    write_binary_plist(&Value::Dictionary(body))
}

fn file_descriptor_value(file: &FileDescriptor, profile: WireProfile) -> Value {
    let mut dict = plist::Dictionary::new();
    dict.insert("FileName".into(), Value::String(file.file_name.clone()));
    dict.insert("FileType".into(), Value::String(file.file_type.clone()));
    if profile == WireProfile::Omdrop && file.size_known {
        dict.insert("FileSize".into(), Value::Integer(file.size.into()));
    }
    dict.insert(
        "FileBomPath".into(),
        Value::String(file.file_bom_path.clone()),
    );
    dict.insert("FileIsDirectory".into(), Value::Boolean(file.is_directory));
    dict.insert("ConvertMediaFormats".into(), Value::Boolean(false));
    Value::Dictionary(dict)
}

fn validate_sender(sender: &SenderIdentity) -> io::Result<()> {
    validate_short_text(&sender.computer_name, "sender name", 63)?;
    validate_short_text(&sender.model_name, "sender model", 63)?;
    validate_short_text(&sender.service_id, "sender ID", 128)?;
    validate_short_text(&sender.bundle_id, "bundle ID", 255)?;
    if sender
        .record_data
        .as_ref()
        .is_some_and(|data| data.len() > MAX_METADATA_BYTES / 2)
    {
        return Err(invalid("sender identity record exceeds limit"));
    }
    Ok(())
}

fn validate_short_text(value: &str, label: &str, max: usize) -> io::Result<()> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(invalid(format!("invalid {label}")));
    }
    Ok(())
}

fn validate_descriptors(files: &[FileDescriptor]) -> io::Result<()> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(invalid("file count is outside the supported range"));
    }
    let mut names = HashSet::new();
    let mut total = 0_u64;
    for file in files {
        validate_file_name(&file.file_name)?;
        validate_short_text(&file.file_type, "file type", 255)?;
        if file.is_directory {
            return Err(invalid("directory transfers are not supported"));
        }
        if file.file_bom_path != format!("./{}", file.file_name) {
            return Err(invalid("FileBomPath must be ./<filename>"));
        }
        if !names.insert(file.file_name.to_lowercase()) {
            return Err(invalid("duplicate filenames are not allowed"));
        }
        if file.size > MAX_FILE_BYTES {
            return Err(invalid("file exceeds the transfer limit"));
        }
        total = total
            .checked_add(file.size)
            .ok_or_else(|| invalid("transfer size overflow"))?;
    }
    if total > MAX_TRANSFER_BYTES {
        return Err(invalid("transfer exceeds the total size limit"));
    }
    Ok(())
}

fn validate_file_name(name: &str) -> io::Result<()> {
    if name.is_empty()
        || name.len() > MAX_NAME_BYTES
        || name == "."
        || name == ".."
        || name.ends_with(' ')
        || name.ends_with('.')
        || name.chars().any(|ch| {
            ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
    {
        return Err(invalid("unsafe or unsupported filename"));
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end_matches(|ch| ch == ' ' || ch == '.')
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
    {
        return Err(invalid("filename is reserved by Windows"));
    }
    Ok(())
}

fn uti_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "public.jpeg",
        "png" => "public.png",
        "heic" => "public.heic",
        "mov" => "com.apple.quicktime-movie",
        "mp4" => "public.mpeg-4",
        "pdf" => "com.adobe.pdf",
        "txt" => "public.plain-text",
        _ => "public.data",
    }
}

/// Parse and validate an incoming `/Ask`. The caller must present the returned
/// proposal to the user, then call `decide_ask`; parsing never authorizes data
/// writes. Legacy OpenDrop asks may omit TransferID and FileSize.
pub fn parse_ask_request(bytes: &[u8]) -> io::Result<AskProposal> {
    let dict = dictionary(read_binary_plist(bytes)?)?;
    if let Some(transfer_type) = dict.get("TransferType") {
        let transfer_type = transfer_type
            .as_dictionary()
            .ok_or_else(|| invalid("TransferType must be a dictionary"))?;
        if transfer_type.len() != 1
            || !transfer_type
                .get("files")
                .is_some_and(|value| value.as_dictionary().is_some())
        {
            return Err(invalid("only file TransferType is supported"));
        }
    }
    let raw_files = dict
        .get("Files")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("Ask.Files must be an array"))?;
    if raw_files.is_empty() || raw_files.len() > MAX_FILES {
        return Err(invalid("Ask file count is outside the supported range"));
    }

    let mut files = Vec::with_capacity(raw_files.len());
    for item in raw_files {
        let entry = match item {
            Value::Dictionary(entry) => entry,
            _ => return Err(invalid("Ask.Files entries must be dictionaries")),
        };
        let file_name = value_string(entry.get("FileName"), "FileName")?
            .ok_or_else(|| invalid("FileName is required"))?;
        validate_file_name(&file_name)?;
        let file_type = value_string(entry.get("FileType"), "FileType")?
            .unwrap_or_else(|| "public.data".to_string());
        validate_short_text(&file_type, "file type", 255)?;
        let size = match entry.get("FileSize") {
            Some(Value::Integer(value)) => {
                let size = value
                    .as_unsigned()
                    .ok_or_else(|| invalid("FileSize cannot be negative"))?;
                if size > MAX_FILE_BYTES {
                    return Err(invalid("FileSize exceeds the per-file limit"));
                }
                Some(size)
            }
            None => None,
            _ => return Err(invalid("FileSize must be an integer")),
        };
        let bom_path = value_string(entry.get("FileBomPath"), "FileBomPath")?
            .unwrap_or_else(|| format!("./{file_name}"));
        if bom_path != format!("./{file_name}") {
            return Err(invalid("FileBomPath must be ./<filename>"));
        }
        let is_directory = match entry.get("FileIsDirectory") {
            Some(Value::Boolean(value)) => *value,
            None => false,
            _ => return Err(invalid("FileIsDirectory must be a boolean")),
        };
        if is_directory {
            return Err(invalid("directory transfers are not supported"));
        }
        files.push(FileDescriptor {
            file_name,
            file_type,
            size: size.unwrap_or(0),
            size_known: size.is_some(),
            file_bom_path: bom_path,
            is_directory,
        });
    }
    validate_descriptors(&files)?;

    let transfer_id = match dict.get("TransferID") {
        Some(Value::Dictionary(id)) => value_string(id.get("id"), "TransferID.id")?,
        None => None,
        _ => return Err(invalid("TransferID must be a dictionary")),
    };
    if let Some(id) = &transfer_id {
        let parsed = Uuid::parse_str(id).map_err(|_| invalid("invalid TransferID UUID"))?;
        if parsed.hyphenated().to_string().to_uppercase().as_str() != id.as_str() {
            return Err(invalid("TransferID must be a canonical UUID"));
        }
    }
    let sender_name = value_string(dict.get("SenderComputerName"), "SenderComputerName")?;
    let sender_model = value_string(dict.get("SenderModelName"), "SenderModelName")?;
    let sender_id = value_string(dict.get("SenderID"), "SenderID")?;
    if let Some(name) = &sender_name {
        validate_short_text(name, "sender name", 63)?;
    }
    if let Some(model) = &sender_model {
        validate_short_text(model, "sender model", 63)?;
    }
    if let Some(id) = &sender_id {
        validate_short_text(id, "sender ID", 128)?;
    }
    if let Some(tag) = dict.get("SenderIdentityAuthTag") {
        match tag {
            Value::Data(bytes) if bytes.len() == 3 => {}
            _ => {
                return Err(invalid(
                    "SenderIdentityAuthTag must contain exactly 3 bytes",
                ))
            }
        }
    }
    Ok(AskProposal {
        transfer_id,
        sender_name,
        sender_model,
        sender_id,
        files,
    })
}

/// Answer an Ask only after the UI has supplied an explicit decision. A
/// rejected transfer is denied before the receiver proceeds to `/Upload`.
pub fn decide_ask(
    proposal: &AskProposal,
    decision: ApprovalDecision,
    receiver: &ReceiverIdentity,
) -> io::Result<AskDecision> {
    match decision {
        ApprovalDecision::Reject => Ok(AskDecision::Rejected { http_status: 403 }),
        ApprovalDecision::Accept => {
            validate_descriptors(&proposal.files)?;
            validate_short_text(&receiver.computer_name, "receiver name", 63)?;
            validate_short_text(&receiver.model_name, "receiver model", 63)?;
            if receiver.media_capabilities_json.len() > MAX_METADATA_BYTES / 2 {
                return Err(invalid("media capabilities exceed metadata limit"));
            }
            serde_json::from_slice::<serde_json::Value>(&receiver.media_capabilities_json)
                .map_err(|_| invalid("media capabilities must be valid JSON"))?;
            if receiver
                .record_data
                .as_ref()
                .is_some_and(|data| data.len() > MAX_METADATA_BYTES / 2)
            {
                return Err(invalid("receiver identity record exceeds limit"));
            }
            let mut body = plist::Dictionary::new();
            body.insert(
                "ReceiverComputerName".into(),
                Value::String(receiver.computer_name.clone()),
            );
            body.insert(
                "ReceiverModelName".into(),
                Value::String(receiver.model_name.clone()),
            );
            body.insert(
                "ReceiverMediaCapabilities".into(),
                Value::Data(receiver.media_capabilities_json.clone()),
            );
            body.insert("IsAirDropable".into(), Value::Boolean(true));
            if let Some(record) = &receiver.record_data {
                body.insert("ReceiverRecordData".into(), Value::Data(record.clone()));
            }
            let response_plist = write_binary_plist(&Value::Dictionary(body))?;
            Ok(AskDecision::Accepted {
                response_plist,
                permit: ApprovedTransfer {
                    transfer_id: proposal.transfer_id.clone(),
                    files: proposal.files.clone(),
                },
            })
        }
    }
}

/// File data source for streaming an archive. Names must be plain basenames;
/// the encoded archive stores each path as `./<filename>` like OpenDrop/Omdrop.
pub struct CpioSource<'a> {
    pub name: &'a str,
    pub size: u64,
    pub reader: &'a mut dyn Read,
}

/// Write POSIX `newc` (070701) cpio with UTF-8 filenames and 4-byte alignment.
/// The numeric header fields are eight-character ASCII hexadecimal values,
/// including filesize and namesize; they are not native-endian integers.
pub fn write_cpio_newc<W: Write>(
    writer: &mut W,
    sources: &mut [CpioSource<'_>],
) -> io::Result<u64> {
    if sources.is_empty() || sources.len() > MAX_FILES {
        return Err(invalid("cpio file count is outside the supported range"));
    }
    let mut names = HashSet::new();
    let mut total = 0_u64;
    for source in sources.iter() {
        validate_file_name(source.name)?;
        if !names.insert(source.name.to_lowercase()) {
            return Err(invalid("duplicate cpio filenames are not allowed"));
        }
        if source.size > MAX_FILE_BYTES {
            return Err(invalid("cpio file exceeds per-file limit"));
        }
        total = total
            .checked_add(source.size)
            .ok_or_else(|| invalid("cpio size overflow"))?;
    }
    if total > MAX_TRANSFER_BYTES {
        return Err(invalid("cpio archive exceeds transfer limit"));
    }

    let mut archive_bytes = 0_u64;
    for (index, source) in sources.iter_mut().enumerate() {
        let path = format!("./{}", source.name);
        let name = path.as_bytes();
        let namesize = u32::try_from(name.len() + 1).map_err(|_| invalid("cpio name too long"))?;
        let filesize = u32::try_from(source.size).map_err(|_| invalid("cpio file is too large"))?;
        write_newc_header(writer, index as u32 + 1, 0o100644, 1, 0, filesize, namesize)?;
        writer.write_all(name)?;
        writer.write_all(&[0])?;
        let name_pad = pad_len(110 + name.len() + 1);
        write_zeroes(writer, name_pad)?;
        let mut left = source.size;
        let mut buffer = [0_u8; COPY_BUFFER_BYTES];
        while left > 0 {
            let take = left.min(buffer.len() as u64) as usize;
            source.reader.read_exact(&mut buffer[..take])?;
            writer.write_all(&buffer[..take])?;
            left -= take as u64;
        }
        let file_pad = pad_len(source.size as usize);
        write_zeroes(writer, file_pad)?;
        archive_bytes = archive_bytes
            .checked_add(
                110 + name.len() as u64 + 1 + name_pad as u64 + source.size + file_pad as u64,
            )
            .ok_or_else(|| invalid("cpio archive size overflow"))?;
    }

    let trailer = b"TRAILER!!!";
    write_newc_header(writer, 0, 0, 1, 0, 0, (trailer.len() + 1) as u32)?;
    writer.write_all(trailer)?;
    writer.write_all(&[0])?;
    let trailer_pad = pad_len(110 + trailer.len() + 1);
    write_zeroes(writer, trailer_pad)?;
    archive_bytes += 110 + trailer.len() as u64 + 1 + trailer_pad as u64;
    Ok(archive_bytes)
}

fn write_newc_header<W: Write>(
    writer: &mut W,
    ino: u32,
    mode: u32,
    nlink: u32,
    mtime: u32,
    filesize: u32,
    namesize: u32,
) -> io::Result<()> {
    writer.write_all(b"070701")?;
    for value in [
        ino, mode, 0, 0, nlink, mtime, filesize, 0, 0, 0, 0, namesize, 0,
    ] {
        write!(writer, "{value:08x}")?;
    }
    Ok(())
}

fn pad_len(length: usize) -> usize {
    (4 - (length % 4)) % 4
}

fn write_zeroes<W: Write>(writer: &mut W, count: usize) -> io::Result<()> {
    const ZEROES: [u8; 3] = [0; 3];
    writer.write_all(&ZEROES[..count])
}

/// OpenDrop legacy profile: content type application/x-cpio, body is gzip of
/// the cpio archive (the profile used by its current `AirDropClient`).
pub fn write_opendrop_gzip<W: Write>(writer: W, sources: &mut [CpioSource<'_>]) -> io::Result<W> {
    let mut encoder = GzEncoder::new(writer, Compression::default());
    write_cpio_newc(&mut encoder, sources)?;
    encoder.finish()
}

/// Current Omdrop profile: 64 KiB cpio blocks, zlib-compressed when smaller;
/// otherwise high-bit-set stored blocks. Block lengths are big-endian u32.
pub fn write_omdrop_dvzip<W: Write>(writer: W, sources: &mut [CpioSource<'_>]) -> io::Result<W> {
    let mut encoder = DvzipEncoder::new(writer);
    write_cpio_newc(&mut encoder, sources)?;
    encoder.finish()
}

struct DvzipEncoder<W: Write> {
    inner: W,
    block: Vec<u8>,
}

impl<W: Write> DvzipEncoder<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            block: Vec::with_capacity(DVZIP_BLOCK_BYTES),
        }
    }

    fn flush_block(&mut self) -> io::Result<()> {
        if self.block.is_empty() {
            return Ok(());
        }
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
        encoder.write_all(&self.block)?;
        let compressed = encoder.finish()?;
        if compressed.len() < self.block.len() {
            let size =
                u32::try_from(compressed.len()).map_err(|_| invalid("DVZip block too large"))?;
            self.inner.write_all(&size.to_be_bytes())?;
            self.inner.write_all(&compressed)?;
        } else {
            let size =
                u32::try_from(self.block.len()).map_err(|_| invalid("DVZip block too large"))?;
            self.inner.write_all(&(size | 0x8000_0000).to_be_bytes())?;
            self.inner.write_all(&self.block)?;
        }
        self.block.clear();
        Ok(())
    }

    fn finish(mut self) -> io::Result<W> {
        self.flush_block()?;
        self.inner.flush()?;
        Ok(self.inner)
    }
}

impl<W: Write> Write for DvzipEncoder<W> {
    fn write(&mut self, mut data: &[u8]) -> io::Result<usize> {
        let original_len = data.len();
        while !data.is_empty() {
            let room = DVZIP_BLOCK_BYTES - self.block.len();
            let count = room.min(data.len());
            self.block.extend_from_slice(&data[..count]);
            data = &data[count..];
            if self.block.len() == DVZIP_BLOCK_BYTES {
                self.flush_block()?;
            }
        }
        Ok(original_len)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flush_block()?;
        self.inner.flush()
    }
}

/// Decode an upload only after `decide_ask` returned an approved permit. The
/// HTTP/TLS layer remains responsible for pairing `/Upload` with the same
/// approved connection and matching its TransferID header when present.
pub fn extract_approved_upload<R: Read>(
    mut reader: R,
    content_type: &str,
    header_transfer_id: Option<&str>,
    permit: &ApprovedTransfer,
    destination: &Path,
) -> io::Result<Vec<ReceivedFile>> {
    match (&permit.transfer_id, header_transfer_id) {
        (Some(expected), Some(actual)) if expected == actual => {}
        (None, None) => {}
        _ => return Err(invalid("Upload TransferID does not match approved Ask")),
    }
    let destination = destination.canonicalize()?;
    if !destination.is_dir() {
        return Err(invalid("receive destination is not a directory"));
    }

    let content_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let decoder: Box<dyn Read> = match content_type.as_str() {
        OPEN_DROP_CONTENT_TYPE => Box::new(GzDecoder::new(reader)),
        OMDROP_CONTENT_TYPE => {
            let mut prefix = [0; 2];
            let count = reader.read(&mut prefix)?;
            if count == 2 && prefix == [0x1f, 0x8b] {
                Box::new(GzDecoder::new(PrefixReader::new(prefix.to_vec(), reader)))
            } else {
                Box::new(DvzipDecoder::new(PrefixReader::new(
                    prefix[..count].to_vec(),
                    reader,
                )))
            }
        }
        _ => return Err(invalid("unsupported AirDrop upload content type")),
    };
    let mut limited = LimitedReader::new(decoder, MAX_ARCHIVE_BYTES);
    extract_cpio_newc(&mut limited, permit, &destination)
}

struct PrefixReader<R> {
    prefix: Cursor<Vec<u8>>,
    rest: R,
}

impl<R> PrefixReader<R> {
    fn new(prefix: Vec<u8>, rest: R) -> Self {
        Self {
            prefix: Cursor::new(prefix),
            rest,
        }
    }
}

impl<R: Read> Read for PrefixReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.prefix.read(buffer)?;
        if count > 0 {
            return Ok(count);
        }
        self.rest.read(buffer)
    }
}

struct LimitedReader<R> {
    inner: R,
    read: u64,
    limit: u64,
}

impl<R> LimitedReader<R> {
    fn new(inner: R, limit: u64) -> Self {
        Self {
            inner,
            read: 0,
            limit,
        }
    }
}

impl<R: Read> Read for LimitedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.read >= self.limit {
            let mut probe = [0_u8; 1];
            if self.inner.read(&mut probe)? != 0 {
                return Err(invalid("decompressed archive exceeds size limit"));
            }
            return Ok(0);
        }
        let available = buffer.len().min((self.limit - self.read) as usize);
        let count = self.inner.read(&mut buffer[..available])?;
        self.read += count as u64;
        Ok(count)
    }
}

struct DvzipDecoder<R> {
    inner: R,
    current: Vec<u8>,
    offset: usize,
    ended: bool,
}

impl<R> DvzipDecoder<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            current: Vec::new(),
            offset: 0,
            ended: false,
        }
    }
}

impl<R: Read> DvzipDecoder<R> {
    fn next_block(&mut self) -> io::Result<()> {
        let mut header = [0_u8; 4];
        let first = self.inner.read(&mut header[..1])?;
        if first == 0 {
            self.ended = true;
            return Ok(());
        }
        self.inner.read_exact(&mut header[1..])?;
        let marker = u32::from_be_bytes(header);
        let size = (marker & 0x7fff_ffff) as usize;
        if size == 0 || size > DVZIP_BLOCK_BYTES {
            return Err(invalid("invalid DVZip block size"));
        }
        let mut payload = vec![0; size];
        self.inner.read_exact(&mut payload)?;
        if marker & 0x8000_0000 != 0 {
            self.current = payload;
        } else {
            let mut decoder = ZlibDecoder::new(Cursor::new(payload));
            self.current.clear();
            Read::by_ref(&mut decoder)
                .take((DVZIP_BLOCK_BYTES + 1) as u64)
                .read_to_end(&mut self.current)?;
            if self.current.is_empty() || self.current.len() > DVZIP_BLOCK_BYTES {
                return Err(invalid("DVZip inflated block exceeds 64 KiB"));
            }
            if decoder.total_in() != decoder.get_ref().get_ref().len() as u64 {
                return Err(invalid("DVZip compressed block has trailing data"));
            }
        }
        self.offset = 0;
        Ok(())
    }
}

impl<R: Read> Read for DvzipDecoder<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        while self.offset >= self.current.len() && !self.ended {
            self.next_block()?;
        }
        if self.offset >= self.current.len() {
            return Ok(0);
        }
        let count = buffer.len().min(self.current.len() - self.offset);
        buffer[..count].copy_from_slice(&self.current[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
}

struct StagedFile {
    temp: PathBuf,
    final_path: PathBuf,
    name: String,
    size: u64,
}

fn extract_cpio_newc<R: Read>(
    reader: &mut R,
    permit: &ApprovedTransfer,
    destination: &Path,
) -> io::Result<Vec<ReceivedFile>> {
    let mut staged = Vec::<StagedFile>::new();
    let mut committed = Vec::<PathBuf>::new();
    let result = (|| {
        let mut total = 0_u64;
        let mut seen = HashSet::<String>::new();
        loop {
            let mut header = [0_u8; 110];
            reader.read_exact(&mut header)?;
            if &header[..6] != b"070701" {
                return Err(invalid("expected cpio newc header 070701"));
            }
            let fields = parse_newc_fields(&header[6..])?;
            let file_size = fields[6] as u64;
            let name_size = fields[11] as usize;
            if name_size == 0 || name_size > MAX_NAME_BYTES + 3 {
                return Err(invalid("invalid cpio filename length"));
            }
            let mut name_bytes = vec![0; name_size];
            reader.read_exact(&mut name_bytes)?;
            if name_bytes.last() != Some(&0) || name_bytes[..name_size - 1].contains(&0) {
                return Err(invalid("invalid cpio filename terminator"));
            }
            let member_path = std::str::from_utf8(&name_bytes[..name_size - 1])
                .map_err(|_| invalid("cpio filename is not UTF-8"))?;
            let name_pad = pad_len(110 + name_size);
            read_zero_padding(reader, name_pad)?;

            if member_path == "TRAILER!!!" {
                if file_size != 0 {
                    return Err(invalid("invalid cpio trailer"));
                }
                break;
            }
            let name = member_basename(member_path)?;
            validate_file_name(name)?;
            let mode = fields[1];
            if mode & 0o170000 != 0o100000 {
                return Err(invalid("cpio archive contains a non-regular file"));
            }
            if file_size > MAX_FILE_BYTES {
                return Err(invalid("cpio member exceeds per-file limit"));
            }
            total = total
                .checked_add(file_size)
                .ok_or_else(|| invalid("cpio size overflow"))?;
            if total > MAX_TRANSFER_BYTES || staged.len() >= MAX_FILES {
                return Err(invalid("cpio archive exceeds transfer limits"));
            }
            let key = name.to_lowercase();
            if !seen.insert(key) {
                return Err(invalid("cpio archive contains duplicate filenames"));
            }
            let expected = permit
                .files
                .iter()
                .find(|file| file.file_name.eq_ignore_ascii_case(name))
                .ok_or_else(|| invalid("archive includes a file not in the approved Ask"))?;
            if expected.file_name != name {
                return Err(invalid("archive filename differs from approved Ask"));
            }
            if expected.size_known && expected.size != file_size {
                return Err(invalid("archive file size differs from approved Ask"));
            }

            let temp = destination.join(format!(".hover-airdrop-{}.part", Uuid::new_v4()));
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            let write_result = (|| {
                let mut left = file_size;
                let mut buffer = [0_u8; COPY_BUFFER_BYTES];
                while left > 0 {
                    let take = left.min(buffer.len() as u64) as usize;
                    reader.read_exact(&mut buffer[..take])?;
                    output.write_all(&buffer[..take])?;
                    left -= take as u64;
                }
                output.sync_all()
            })();
            drop(output);
            if let Err(error) = write_result {
                let _ = fs::remove_file(&temp);
                return Err(error);
            }
            let data_pad = pad_len(file_size as usize);
            read_zero_padding(reader, data_pad)?;
            staged.push(StagedFile {
                temp,
                final_path: destination.join(name),
                name: name.to_string(),
                size: file_size,
            });
        }

        if staged.len() != permit.files.len() {
            return Err(invalid("archive file list does not match approved Ask"));
        }
        let mut trailing_zeroes = 0usize;
        for byte in reader.bytes() {
            if byte? != 0 {
                return Err(invalid("non-zero data follows cpio trailer"));
            }
            trailing_zeroes += 1;
            if trailing_zeroes > 511 {
                return Err(invalid("excessive padding follows cpio trailer"));
            }
        }

        for file in &staged {
            // Hard-linking the completed staged file is an atomic no-clobber
            // commit. Existing files (including symlinks) are never replaced.
            fs::hard_link(&file.temp, &file.final_path)?;
            committed.push(file.final_path.clone());
        }
        Ok(staged
            .iter()
            .map(|file| ReceivedFile {
                name: file.name.clone(),
                path: file.final_path.clone(),
                bytes: file.size,
            })
            .collect())
    })();

    for file in &staged {
        let _ = fs::remove_file(&file.temp);
    }
    if result.is_err() {
        for path in committed {
            let _ = fs::remove_file(path);
        }
    }
    result
}

fn parse_newc_fields(bytes: &[u8]) -> io::Result<[u32; 13]> {
    if bytes.len() != 13 * 8 {
        return Err(invalid("invalid cpio newc header length"));
    }
    let mut fields = [0_u32; 13];
    for (index, slot) in fields.iter_mut().enumerate() {
        let start = index * 8;
        let text = std::str::from_utf8(&bytes[start..start + 8])
            .map_err(|_| invalid("invalid cpio hexadecimal field"))?;
        *slot =
            u32::from_str_radix(text, 16).map_err(|_| invalid("invalid cpio hexadecimal field"))?;
    }
    Ok(fields)
}

fn member_basename(path: &str) -> io::Result<&str> {
    let name = path
        .strip_prefix("./")
        .ok_or_else(|| invalid("cpio path must be ./<filename>"))?;
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Err(invalid("nested or traversing cpio paths are not allowed"));
    }
    Ok(name)
}

fn read_zero_padding<R: Read>(reader: &mut R, count: usize) -> io::Result<()> {
    let mut bytes = [0_u8; 3];
    reader.read_exact(&mut bytes[..count])?;
    if bytes[..count].iter().any(|byte| *byte != 0) {
        return Err(invalid("cpio padding must be zero"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn sender() -> SenderIdentity {
        SenderIdentity {
            computer_name: "Hover Island".into(),
            model_name: "MacBookPro18,3".into(),
            service_id: "A1B2C3D4E5F6".into(),
            bundle_id: "com.apple.finder".into(),
            record_data: None,
            identity_auth_tag: None,
        }
    }

    fn receiver() -> ReceiverIdentity {
        ReceiverIdentity {
            computer_name: "Hover Island".into(),
            model_name: "MacBookPro18,3".into(),
            media_capabilities_json: br#"{"Version":1}"#.to_vec(),
            record_data: None,
        }
    }

    fn descriptor(name: &str, size: u64) -> FileDescriptor {
        FileDescriptor {
            file_name: name.into(),
            file_type: "public.jpeg".into(),
            size,
            size_known: true,
            file_bom_path: format!("./{name}"),
            is_directory: false,
        }
    }

    fn approved(name: &str, size: u64, id: Uuid) -> ApprovedTransfer {
        ApprovedTransfer {
            transfer_id: Some(id.hyphenated().to_string().to_uppercase()),
            files: vec![descriptor(name, size)],
        }
    }

    fn payload(profile: WireProfile, name: &str, bytes: &[u8]) -> (Vec<u8>, String) {
        let mut raw = Cursor::new(bytes);
        let mut sources = [CpioSource {
            name,
            size: bytes.len() as u64,
            reader: &mut raw,
        }];
        let encoded = match profile {
            WireProfile::OpenDrop => {
                let encoded = write_opendrop_gzip(Vec::new(), &mut sources).unwrap();
                (encoded, OPEN_DROP_CONTENT_TYPE.to_string())
            }
            WireProfile::Omdrop => {
                let encoded = write_omdrop_dvzip(Vec::new(), &mut sources).unwrap();
                (encoded, OMDROP_CONTENT_TYPE.to_string())
            }
        };
        encoded
    }

    #[test]
    fn discover_and_ask_use_upstream_binary_plist_fields() {
        let discover = build_discover_request(WireProfile::Omdrop, None).unwrap();
        let discover: Value = plist::from_bytes(&discover).unwrap();
        let discover = discover.as_dictionary().unwrap();
        assert_eq!(
            discover
                .get("DeviceSupportFlags")
                .unwrap()
                .as_signed_integer(),
            Some(111_611)
        );

        let transfer_id = Uuid::parse_str("9d6404cc-5774-4a39-990e-5be055e65832").unwrap();
        let ask = build_ask_request(
            WireProfile::Omdrop,
            &sender(),
            transfer_id,
            &[descriptor("photo.jpg", 3)],
        )
        .unwrap();
        assert!(ask.starts_with(b"bplist00"));
        let ask: Value = plist::from_bytes(&ask).unwrap();
        let ask = ask.as_dictionary().unwrap();
        assert_eq!(
            ask.get("BundleID").unwrap().as_string(),
            Some("com.apple.finder")
        );
        assert_eq!(
            ask.get("ConvertMediaFormats").unwrap().as_boolean(),
            Some(false)
        );
        assert_eq!(
            ask.get("TransferID")
                .and_then(Value::as_dictionary)
                .and_then(|d| d.get("id"))
                .and_then(Value::as_string),
            Some("9D6404CC-5774-4A39-990E-5BE055E65832")
        );
        let file = &ask.get("Files").unwrap().as_array().unwrap()[0];
        let file = file.as_dictionary().unwrap();
        assert_eq!(file.get("FileName").unwrap().as_string(), Some("photo.jpg"));
        assert_eq!(
            file.get("FileType").unwrap().as_string(),
            Some("public.jpeg")
        );
        assert_eq!(
            file.get("FileBomPath").unwrap().as_string(),
            Some("./photo.jpg")
        );
        assert_eq!(file.get("FileSize").unwrap().as_signed_integer(), Some(3));
    }

    #[test]
    fn discovers_upstream_response_and_rejects_wrong_root_type() {
        let response = Value::Dictionary(plist::Dictionary::from_iter([
            (
                "ReceiverComputerName".to_string(),
                Value::String("iPhone".into()),
            ),
            (
                "ReceiverModelName".to_string(),
                Value::String("iPhone17,1".into()),
            ),
            (
                "ReceiverMediaCapabilities".to_string(),
                Value::Data(br#"{"Version":3}"#.to_vec()),
            ),
            ("IsAirDropable".to_string(), Value::Boolean(true)),
        ]));
        let mut binary = Vec::new();
        response.to_writer_binary(&mut binary).unwrap();
        let decoded = parse_discover_response(&binary).unwrap();
        assert_eq!(decoded.computer_name.as_deref(), Some("iPhone"));
        assert_eq!(decoded.model_name.as_deref(), Some("iPhone17,1"));
        assert_eq!(decoded.is_airdropable, Some(true));
        assert_eq!(
            parse_discover_response(b"not a plist").unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn incoming_ask_has_to_be_approved_before_it_gets_a_write_permit() {
        let id = Uuid::parse_str("9d6404cc-5774-4a39-990e-5be055e65832").unwrap();
        let encoded = build_ask_request(
            WireProfile::Omdrop,
            &sender(),
            id,
            &[descriptor("x.txt", 1)],
        )
        .unwrap();
        let proposal = parse_ask_request(&encoded).unwrap();
        assert_eq!(proposal.files[0].file_name, "x.txt");
        assert!(matches!(
            decide_ask(&proposal, ApprovalDecision::Reject, &receiver()).unwrap(),
            AskDecision::Rejected { http_status: 403 }
        ));
        assert!(matches!(
            decide_ask(&proposal, ApprovalDecision::Accept, &receiver()).unwrap(),
            AskDecision::Accepted { .. }
        ));
    }

    #[test]
    fn legacy_opendrop_ask_keeps_file_size_unknown_instead_of_calling_it_zero() {
        let mut file = plist::Dictionary::new();
        file.insert("FileName".into(), Value::String("legacy.txt".into()));
        file.insert("FileType".into(), Value::String("public.plain-text".into()));
        file.insert("FileBomPath".into(), Value::String("./legacy.txt".into()));
        file.insert("FileIsDirectory".into(), Value::Boolean(false));
        file.insert("ConvertMediaFormats".into(), Value::Boolean(false));
        let mut ask = plist::Dictionary::new();
        ask.insert("BundleID".into(), Value::String("com.apple.finder".into()));
        ask.insert("Files".into(), Value::Array(vec![Value::Dictionary(file)]));
        let bytes = write_binary_plist(&Value::Dictionary(ask)).unwrap();
        let parsed = parse_ask_request(&bytes).unwrap();
        assert_eq!(parsed.files[0].file_name, "legacy.txt");
        assert_eq!(parsed.files[0].size, 0);
        assert!(!parsed.files[0].size_known);
    }

    #[test]
    fn cpio_newc_round_trips_with_opendrop_gzip_and_omdrop_dvzip() {
        for profile in [WireProfile::OpenDrop, WireProfile::Omdrop] {
            let bytes = b"real payload bytes";
            let (encoded, content_type) = payload(profile, "photo.jpg", bytes);
            let id = Uuid::parse_str("9d6404cc-5774-4a39-990e-5be055e65832").unwrap();
            let permit = approved("photo.jpg", bytes.len() as u64, id);
            let temp = tempfile_dir();
            let result = extract_approved_upload(
                Cursor::new(encoded),
                &content_type,
                Some("9D6404CC-5774-4A39-990E-5BE055E65832"),
                &permit,
                &temp,
            )
            .unwrap();
            assert_eq!(result.len(), 1);
            assert_eq!(fs::read(&result[0].path).unwrap(), bytes);
            let _ = fs::remove_dir_all(temp);
        }
    }

    fn tempfile_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("hover-airdrop-test-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn rejects_path_traversal_and_never_overwrites_existing_files() {
        let id = Uuid::parse_str("9d6404cc-5774-4a39-990e-5be055e65832").unwrap();
        let temp = tempfile_dir();
        assert!(validate_file_name("..\\escape.txt").is_err());
        assert!(member_basename("./../escape.txt").is_err());

        // Build an adversarial archive without going through the safe writer.
        let unsafe_name = b"./../escape.txt";
        let mut raw = Vec::new();
        write_newc_header(
            &mut raw,
            1,
            0o100644,
            1,
            0,
            3,
            (unsafe_name.len() + 1) as u32,
        )
        .unwrap();
        raw.extend_from_slice(unsafe_name);
        raw.push(0);
        write_zeroes(&mut raw, pad_len(110 + unsafe_name.len() + 1)).unwrap();
        raw.extend_from_slice(b"bad");
        write_zeroes(&mut raw, pad_len(3)).unwrap();
        write_newc_header(&mut raw, 0, 0, 1, 0, 0, 11).unwrap();
        raw.extend_from_slice(b"TRAILER!!!\0");
        write_zeroes(&mut raw, pad_len(110 + 11)).unwrap();
        let mut dvzip = DvzipEncoder::new(Vec::new());
        dvzip.write_all(&raw).unwrap();
        let traversal = dvzip.finish().unwrap();
        let permit = approved("escape.txt", 3, id);
        assert!(extract_approved_upload(
            Cursor::new(traversal),
            OMDROP_CONTENT_TYPE,
            Some("9D6404CC-5774-4A39-990E-5BE055E65832"),
            &permit,
            &temp,
        )
        .is_err());
        assert_eq!(fs::read_dir(&temp).unwrap().count(), 0);

        let (encoded, content_type) = payload(WireProfile::Omdrop, "safe.txt", b"new");
        fs::write(temp.join("safe.txt"), b"old").unwrap();
        let permit = approved("safe.txt", 3, id);
        assert!(extract_approved_upload(
            Cursor::new(encoded),
            &content_type,
            Some("9D6404CC-5774-4A39-990E-5BE055E65832"),
            &permit,
            &temp,
        )
        .is_err());
        assert_eq!(fs::read(temp.join("safe.txt")).unwrap(), b"old");
        assert_eq!(fs::read_dir(&temp).unwrap().count(), 1);
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn rejects_mismatched_upload_transfer_id_and_oversized_metadata() {
        let (encoded, content_type) = payload(WireProfile::Omdrop, "safe.txt", b"new");
        let temp = tempfile_dir();
        let permit = approved(
            "safe.txt",
            3,
            Uuid::parse_str("9d6404cc-5774-4a39-990e-5be055e65832").unwrap(),
        );
        assert!(extract_approved_upload(
            Cursor::new(encoded),
            &content_type,
            Some("wrong"),
            &permit,
            &temp
        )
        .is_err());
        assert_eq!(fs::read_dir(&temp).unwrap().count(), 0);
        assert!(read_binary_plist(&vec![0; MAX_METADATA_BYTES + 1]).is_err());
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn cpio_writer_uses_newc_hex_fields_and_four_byte_alignment() {
        let mut data = Cursor::new(b"abc".to_vec());
        let mut sources = [CpioSource {
            name: "a",
            size: 3,
            reader: &mut data,
        }];
        let mut archive = Vec::new();
        write_cpio_newc(&mut archive, &mut sources).unwrap();
        assert_eq!(&archive[..6], b"070701");
        assert_eq!(&archive[14..22], b"000081a4"); // c_mode = regular file 0644
        assert_eq!(archive.len() % 4, 0);
        assert!(archive.windows(10).any(|window| window == b"TRAILER!!!"));
    }

    #[test]
    fn upload_encoders_follow_the_two_upstream_wire_framings() {
        let bytes = b"file contents";
        let (gzip, content_type) = payload(WireProfile::OpenDrop, "x.txt", bytes);
        assert_eq!(content_type, OPEN_DROP_CONTENT_TYPE);
        assert!(gzip.starts_with(&[0x1f, 0x8b]));
        let mut open_drop_archive = Vec::new();
        GzDecoder::new(Cursor::new(gzip))
            .read_to_end(&mut open_drop_archive)
            .unwrap();
        assert!(open_drop_archive.starts_with(b"070701"));

        let (dvzip, content_type) = payload(WireProfile::Omdrop, "x.txt", bytes);
        assert_eq!(content_type, OMDROP_CONTENT_TYPE);
        let block_marker = u32::from_be_bytes(dvzip[..4].try_into().unwrap());
        assert_eq!(
            block_marker & 0x8000_0000,
            0,
            "compressible block uses zlib"
        );
        let mut omdrop_archive = Vec::new();
        DvzipDecoder::new(Cursor::new(dvzip))
            .read_to_end(&mut omdrop_archive)
            .unwrap();
        assert!(omdrop_archive.starts_with(b"070701"));
    }

    #[test]
    fn rejects_unsupported_content_type() {
        let temp = tempfile_dir();
        let permit = approved("x", 0, Uuid::new_v4());
        assert!(extract_approved_upload(
            Cursor::new([]),
            "application/octet-stream",
            None,
            &permit,
            &temp
        )
        .is_err());
        let _ = fs::remove_dir_all(temp);
    }
}
