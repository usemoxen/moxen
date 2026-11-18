use base64::{Engine, engine::general_purpose::STANDARD};
use gpui::{Image, ImageFormat};
use serde_json::{Value, json};
use std::{
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
};

// Bound local reads and previews; the server enforces the turn's provider limits.
const READ_LIMIT: usize = 40 * 1024 * 1024;
const IMAGE_BYTES: usize = 15 * 1024 * 1024 / 2;
const PREVIEW_EDGE: u32 = 1568;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Asset {
    Path { path: PathBuf, directory: bool },
    Image { name: String, image: Arc<Image> },
}

impl Asset {
    pub fn name(&self) -> String {
        match self {
            Self::Path { path, .. } => path
                .file_name()
                .unwrap_or(path.as_os_str())
                .to_string_lossy()
                .into(),
            Self::Image { name, .. } => name.clone(),
        }
    }

    pub fn local(path: PathBuf) -> Result<Self, String> {
        let meta = path
            .metadata()
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let format = match path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "gif" => Some(ImageFormat::Gif),
            "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
            "png" => Some(ImageFormat::Png),
            "webp" => Some(ImageFormat::Webp),
            _ => None,
        };
        let Some(format) = format.filter(|_| meta.is_file()) else {
            return Ok(Self::Path {
                path,
                directory: meta.is_dir(),
            });
        };
        let name = path
            .file_name()
            .unwrap_or(path.as_os_str())
            .to_string_lossy()
            .into_owned();
        let mut bytes = Vec::new();
        std::fs::File::open(&path)
            .and_then(|file| file.take((READ_LIMIT + 1) as u64).read_to_end(&mut bytes))
            .map_err(|e| format!("{name}: {e}"))?;
        Self::image(name, Image::from_bytes(format, bytes))
    }

    pub fn image(mut name: String, mut image: Image) -> Result<Self, String> {
        if image.bytes.is_empty() || image.bytes.len() > READ_LIMIT {
            return Err(format!(
                "{name} is empty or exceeds the 40 MB image read limit."
            ));
        }
        let mut reader = ::image::ImageReader::new(Cursor::new(&image.bytes))
            .with_guessed_format()
            .map_err(|e| format!("{name}: {e}"))?;
        let mut limits = ::image::Limits::default();
        limits.max_image_width = Some(16_384);
        limits.max_image_height = Some(16_384);
        reader.limits(limits);
        let decoded = reader.decode().map_err(|e| format!("{name}: {e}"))?;
        let supported = matches!(
            image.format,
            ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::Webp
        ) && ::image::guess_format(&image.bytes)
            .ok()
            .and_then(|format| ImageFormat::from_mime_type(format.to_mime_type()))
            == Some(image.format);
        if !supported
            || image.bytes.len() > IMAGE_BYTES
            || decoded.width().max(decoded.height()) > 2000
        {
            let mut bytes = Cursor::new(Vec::new());
            let resized = decoded.thumbnail(PREVIEW_EDGE, PREVIEW_EDGE);
            resized
                .write_to(&mut bytes, ::image::ImageFormat::Png)
                .map_err(|e| format!("{name}: {e}"))?;
            name = Path::new(&name)
                .with_extension("png")
                .to_string_lossy()
                .into_owned();
            image = Image::from_bytes(ImageFormat::Png, bytes.into_inner());
        }
        Ok(Self::Image {
            name,
            image: Arc::new(image),
        })
    }
}

#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct Prompt {
    pub text: String,
    pub assets: Vec<Asset>,
    pub once: Option<String>,
}

impl From<String> for Prompt {
    fn from(text: String) -> Self {
        Self {
            text,
            ..Self::default()
        }
    }
}
impl From<&str> for Prompt {
    fn from(text: &str) -> Self {
        text.to_owned().into()
    }
}

impl Prompt {
    pub fn wire(&self) -> Value {
        let mut text = self.text.trim().to_owned();
        let mut images = vec![];
        for asset in &self.assets {
            match asset {
                Asset::Path { path, directory } => {
                    if !text.is_empty() {
                        text.push(' ');
                    }
                    let icon = if *directory { "📁" } else { "📄" };
                    let name = asset.name().replace(['\r', '\n'], " ").replace(']', "\\]");
                    let path = path
                        .to_string_lossy()
                        .replace('>', "%3E")
                        .replace('<', "%3C")
                        .replace('\r', "%0D")
                        .replace('\n', "%0A");
                    text.push_str(&format!("[{icon} {name}](<{path}>)"));
                }
                Asset::Image { name, image } => {
                    let mime = image.format.mime_type();
                    images.push(json!({
                        "type": "image", "name": name, "mimeType": mime,
                        "sizeBytes": image.bytes.len(),
                        "dataUrl": format!("data:{mime};base64,{}", STANDARD.encode(&image.bytes)),
                    }));
                }
            }
        }
        // The turn command requires text, even for an image-only draft.
        if text.is_empty() && !images.is_empty() {
            text = (1..=images.len())
                .map(|i| format!("[Image #{i}]"))
                .collect::<Vec<_>>()
                .join(" ");
        }
        let mut message = json!({"text": text});
        if !images.is_empty() {
            message["attachments"] = images.into();
        }
        message
    }
}

pub fn file_chips(text: &str) -> (String, Vec<(String, String)>) {
    static PATH: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\[((?:📄|📁) (?:\\\]|[^\]\n])+)\]\((?:<([^>\n]*)>|([^\s)]*))\)")
            .unwrap()
    });
    let mut chips = vec![];
    let body = PATH.replace_all(text, |cap: &regex::Captures| {
        let path = cap.get(2).or_else(|| cap.get(3)).unwrap().as_str();
        chips.push((cap[1].replace("\\]", "]"), path.to_owned()));
        ""
    });
    (body.trim().to_owned(), chips)
}

pub fn limit(assets: &[Asset]) -> Result<(), &'static str> {
    let mut count = 0;
    let mut bytes = 0;
    for asset in assets {
        if let Asset::Image { image, .. } = asset {
            count += 1;
            bytes += image.bytes.len().div_ceil(3) * 4 + "data:image/jpeg;base64,".len();
        }
    }
    if count > 100 {
        Err("A message can carry at most 100 images.")
    } else if bytes > 30 * 1024 * 1024 {
        Err("These images exceed the 30 MB encoded limit for one message.")
    } else {
        Ok(())
    }
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub enum Picture {
    Stored(String),
    Reply { thread: usize, path: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thumbnail {
    pub name: String,
    pub source: Picture,
}

pub fn decode(value: &Value) -> Result<Arc<Image>, String> {
    let bad = || "The server did not return a supported image.".to_owned();
    let mime = value["mimeType"].as_str().ok_or_else(bad)?;
    let format = match mime {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/webp" => ImageFormat::Webp,
        "image/gif" => ImageFormat::Gif,
        _ => return Err(bad()),
    };
    let data = value["dataUrl"].as_str().ok_or_else(bad)?;
    let (header, encoded) = data.split_once(',').ok_or_else(bad)?;
    if header != format!("data:{mime};base64") || encoded.len() > READ_LIMIT.div_ceil(3) * 4 {
        return Err(bad());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| bad())?;
    if ::image::guess_format(&bytes)
        .ok()
        .map(|format| format.to_mime_type())
        != Some(mime)
    {
        return Err(bad());
    }
    Ok(Arc::new(Image::from_bytes(format, bytes)))
}

pub fn user_images(message: &Value, text: &str) -> (String, Vec<Thumbnail>) {
    static REF: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"!?\[([^\]]*)\]\(moxen-context://v1/image/([^)]+)\)").unwrap()
    });
    let mut images = vec![];
    let mut push = |id: &str, name: &str| {
        let source = Picture::Stored(id.to_owned());
        if !images
            .iter()
            .any(|image: &Thumbnail| image.source == source)
        {
            images.push(Thumbnail {
                source,
                name: if name.is_empty() { "Image" } else { name }.to_owned(),
            });
        }
    };
    let cleaned = REF.replace_all(text, |cap: &regex::Captures| {
        if let Some(record) = message["context"]["records"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|record| record["contextId"].as_str() == Some(&cap[2]))
            && let Some(id) = record["attachmentId"].as_str()
        {
            push(id, record["name"].as_str().unwrap_or(&cap[1]));
            return String::new();
        }
        cap[0].to_owned()
    });
    for item in message["attachments"].as_array().into_iter().flatten() {
        if item["type"] == "image"
            && let Some(id) = item["id"].as_str()
        {
            push(id, item["name"].as_str().unwrap_or("Image"));
        }
    }
    (cleaned.trim().to_owned(), images)
}

pub enum ReplyBlock<'a> {
    Text(String),
    Image { label: &'a str, path: &'a str },
}

pub fn reply_blocks(text: &str) -> Vec<ReplyBlock<'_>> {
    static IMAGE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))\)$").unwrap());
    let mut blocks = vec![];
    let mut lines = vec![];
    let mut fence = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(marker) = ["```", "~~~"]
            .into_iter()
            .find(|marker| trimmed.starts_with(marker))
        {
            if fence == Some(marker) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(marker);
            }
        } else if fence.is_none()
            && let Some(cap) = IMAGE.captures(trimmed)
        {
            let path = cap.get(2).or_else(|| cap.get(3)).unwrap().as_str();
            // Only local references; never fetch an address supplied in a reply.
            if !path.contains("://")
                && !path.starts_with("//")
                && (!path.contains(':') || path.as_bytes().get(1) == Some(&b':'))
            {
                if !lines.is_empty() {
                    blocks.push(ReplyBlock::Text(std::mem::take(&mut lines).join("\n")));
                }
                blocks.push(ReplyBlock::Image {
                    path,
                    label: cap.get(1).unwrap().as_str(),
                });
                continue;
            }
        }
        lines.push(line);
    }
    if !lines.is_empty() {
        blocks.push(ReplyBlock::Text(lines.join("\n")));
    }
    blocks
}

#[cfg(test)]
pub const SAMPLE: &str = concat!(
    "data:image/png;base64,",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv2sAAAAASUVORK5CYII="
);

#[cfg(test)]
mod tests {
    use super::{
        Asset, Picture, Prompt, ReplyBlock, SAMPLE, decode, limit, reply_blocks, user_images,
    };
    use gpui::{Image, ImageFormat};
    use serde_json::json;
    use std::{io::Cursor, path::PathBuf, sync::Arc};

    #[test]
    fn uploads_a_native_path_as_text_but_never_as_file_bytes() {
        let path = PathBuf::from("fixture").join("name with spaces.txt");
        let message = Prompt {
            text: "Inspect".into(),
            assets: vec![Asset::Path {
                path: path.clone(),
                directory: false,
            }],
            once: None,
        }
        .wire();
        assert_eq!(
            message,
            json!({"text":format!("Inspect [📄 name with spaces.txt](<{}>)", path.display())})
        );
        let (body, chips) = super::file_chips(message["text"].as_str().unwrap());
        assert_eq!(body, "Inspect");
        assert_eq!(
            chips,
            [(
                "📄 name with spaces.txt".into(),
                path.to_string_lossy().into_owned()
            )]
        );
    }

    #[test]
    fn aggregate_image_limits_count_encoded_bytes_and_images() {
        let image = decode(&json!({"mimeType":"image/png","dataUrl":SAMPLE})).unwrap();
        let small = Asset::Image {
            name: "sample.png".into(),
            image,
        };
        assert!(limit(&vec![small.clone(); 100]).is_ok());
        assert!(limit(&vec![small; 101]).is_err());
        let large = Asset::Image {
            name: "large.png".into(),
            image: Arc::new(Image::from_bytes(
                ImageFormat::Png,
                vec![0; 7 * 1024 * 1024],
            )),
        };
        assert!(limit(&vec![large.clone(); 3]).is_ok());
        assert!(limit(&vec![large; 4]).is_err());
    }

    #[test]
    fn converts_platform_bitmap_and_shrinks_it_for_large_image_sets() {
        let mut bytes = Cursor::new(vec![]);
        image::RgbImage::new(2001, 10)
            .write_to(&mut bytes, image::ImageFormat::Bmp)
            .unwrap();
        let Asset::Image { name, image } = Asset::image(
            "clipboard.bmp".into(),
            Image::from_bytes(ImageFormat::Bmp, bytes.into_inner()),
        )
        .unwrap() else {
            panic!("expected an image")
        };
        assert_eq!(name, "clipboard.png");
        assert_eq!(image.format, ImageFormat::Png);
        assert_eq!(image::load_from_memory(&image.bytes).unwrap().width(), 1568);
        assert!(
            Asset::image(
                "bad.png".into(),
                Image::from_bytes(ImageFormat::Png, vec![1, 2])
            )
            .is_err()
        );
    }

    #[test]
    fn refuses_inconsistent_attachment_data_urls_and_merges_legacy_references() {
        assert!(decode(&json!({"mimeType":"image/png","dataUrl":SAMPLE})).is_ok());
        for (mime, data) in [
            ("image/gif", SAMPLE),
            ("image/png", "data:image/png;base64,YWJj"),
            ("image/png", "data:image/png;base64,!!!"),
        ] {
            assert!(decode(&json!({"mimeType":mime,"dataUrl":data})).is_err());
        }
        let (text, images) = user_images(
            &json!({
              "context":{"records":[{"contextId":"legacy","attachmentId":"id-1","name":"legacy.png"}]},
              "attachments":[{"type":"image","id":"id-1"},{"type":"image","id":"id-2","name":"inline.png"}]
            }),
            "See ![image](moxen-context://v1/image/legacy)",
        );
        assert_eq!(text, "See");
        assert_eq!(
            images
                .iter()
                .map(|image| (&image.name, &image.source))
                .collect::<Vec<_>>(),
            [
                (&"legacy.png".to_owned(), &Picture::Stored("id-1".into())),
                (&"inline.png".to_owned(), &Picture::Stored("id-2".into()))
            ]
        );
    }

    #[test]
    fn extracts_only_standalone_local_reply_images_outside_code_fences() {
        let blocks = reply_blocks(
            "Before\n```md\n![Example](fake.png)\n```\n![Remote](https://example.test/image.png)\n![Crop](<with spaces.png>)\nAfter",
        );
        assert!(
            matches!(&blocks[..], [ReplyBlock::Text(before), ReplyBlock::Image { label: "Crop", path: "with spaces.png" }, ReplyBlock::Text(after)]
            if before.contains("fake.png") && before.contains("https://") && after == "After")
        );
    }
}
