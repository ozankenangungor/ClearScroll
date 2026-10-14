//! Parser for the CSWT weight container produced by `tools/prepare_model.py`.
//!
//! The container is a fixed 44-byte little-endian header followed by raw f32
//! tensors. Parsing is strict: any inconsistency between the header and the
//! payload size is an error, so a truncated download or a file exported for a
//! different architecture can never be loaded as a silently-broken model.

use std::fmt;

pub const MAGIC: &[u8; 4] = b"CSWT";
pub const FORMAT_VERSION: u32 = 1;
pub const HEADER_LEN: usize = 44;
const DTYPE_F32: u32 = 0;

/// Encoder hyper-parameters, read from the weight file header.
#[derive(Clone, Debug, PartialEq)]
pub struct BertConfig {
    pub vocab_size: usize,
    pub hidden_size: usize,
    pub num_layers: usize,
    pub num_heads: usize,
    pub intermediate_size: usize,
    /// Number of position embeddings stored (= maximum sequence length).
    pub max_position: usize,
    pub type_vocab_size: usize,
    pub layer_norm_eps: f64,
}

impl BertConfig {
    pub fn head_dim(&self) -> usize {
        self.hidden_size / self.num_heads
    }

    /// Number of f32 values the payload must contain for this configuration.
    pub fn param_count(&self) -> usize {
        let h = self.hidden_size;
        let i = self.intermediate_size;
        let embeddings =
            self.vocab_size * h + self.max_position * h + self.type_vocab_size * h + 2 * h;
        let per_layer = 4 * (h * h + h) // Q, K, V, attention output
            + 2 * h                     // attention LayerNorm
            + h * i + i                 // FFN intermediate
            + i * h + h                 // FFN output
            + 2 * h; // FFN LayerNorm
        embeddings + self.num_layers * per_layer
    }
}

#[derive(Debug, PartialEq)]
pub enum WeightError {
    TooShort(usize),
    BadMagic,
    UnsupportedVersion(u32),
    UnsupportedDtype(u32),
    InvalidConfig(String),
    SizeMismatch { expected: usize, actual: usize },
    NonFinite(usize),
}

impl fmt::Display for WeightError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShort(n) => {
                write!(f, "weight file is only {n} bytes (header is {HEADER_LEN})")
            }
            Self::BadMagic => write!(f, "not a ClearScroll weight file (bad magic)"),
            Self::UnsupportedVersion(v) => write!(f, "unsupported weight format version {v}"),
            Self::UnsupportedDtype(d) => write!(f, "unsupported weight dtype {d}"),
            Self::InvalidConfig(msg) => write!(f, "invalid model config: {msg}"),
            Self::SizeMismatch { expected, actual } => write!(
                f,
                "weight payload is {actual} bytes but the header describes {expected} bytes \
                 (truncated or corrupt download?)"
            ),
            Self::NonFinite(i) => write!(f, "weight value #{i} is NaN or infinite"),
        }
    }
}

impl std::error::Error for WeightError {}

/// A validated view over a CSWT file.
pub struct WeightFile<'a> {
    pub config: BertConfig,
    payload: &'a [u8],
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

impl<'a> WeightFile<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, WeightError> {
        if bytes.len() < HEADER_LEN {
            return Err(WeightError::TooShort(bytes.len()));
        }
        if &bytes[0..4] != MAGIC {
            return Err(WeightError::BadMagic);
        }
        let version = read_u32(bytes, 4);
        if version != FORMAT_VERSION {
            return Err(WeightError::UnsupportedVersion(version));
        }
        let field = |i: usize| read_u32(bytes, 8 + 4 * i) as usize;
        let eps = f32::from_le_bytes([bytes[36], bytes[37], bytes[38], bytes[39]]);
        let dtype = read_u32(bytes, 40);
        if dtype != DTYPE_F32 {
            return Err(WeightError::UnsupportedDtype(dtype));
        }

        let config = BertConfig {
            vocab_size: field(0),
            hidden_size: field(1),
            num_layers: field(2),
            num_heads: field(3),
            intermediate_size: field(4),
            max_position: field(5),
            type_vocab_size: field(6),
            layer_norm_eps: f64::from(eps),
        };
        validate_config(&config)?;

        let payload = &bytes[HEADER_LEN..];
        let expected = config.param_count() * 4;
        if payload.len() != expected {
            return Err(WeightError::SizeMismatch {
                expected,
                actual: payload.len(),
            });
        }
        Ok(Self { config, payload })
    }

    /// Sequential reader over the payload tensors.
    pub fn reader(&self) -> TensorReader<'a> {
        TensorReader {
            payload: self.payload,
            offset: 0,
            index: 0,
        }
    }
}

fn validate_config(c: &BertConfig) -> Result<(), WeightError> {
    let bad = |msg: &str| Err(WeightError::InvalidConfig(msg.to_string()));
    // Generous upper bounds: they only exist to reject garbage headers before
    // computing (potentially overflowing) payload sizes.
    if c.vocab_size == 0 || c.vocab_size > 1_000_000 {
        return bad("vocab_size out of range");
    }
    if c.hidden_size == 0 || c.hidden_size > 4096 {
        return bad("hidden_size out of range");
    }
    if c.num_layers == 0 || c.num_layers > 48 {
        return bad("num_layers out of range");
    }
    if c.num_heads == 0 || c.hidden_size % c.num_heads != 0 {
        return bad("hidden_size must be divisible by num_heads");
    }
    if c.intermediate_size == 0 || c.intermediate_size > 16384 {
        return bad("intermediate_size out of range");
    }
    if c.max_position < 2 || c.max_position > 4096 {
        return bad("max_position out of range");
    }
    if c.type_vocab_size == 0 || c.type_vocab_size > 16 {
        return bad("type_vocab_size out of range");
    }
    if !(c.layer_norm_eps.is_finite() && c.layer_norm_eps > 0.0 && c.layer_norm_eps < 1e-2) {
        return bad("layer_norm_eps out of range");
    }
    Ok(())
}

pub struct TensorReader<'a> {
    payload: &'a [u8],
    offset: usize,
    index: usize,
}

impl TensorReader<'_> {
    /// Read the next `n` f32 values. The payload length was validated up front,
    /// so running past the end is a programming error in the caller's tensor
    /// order and is reported rather than panicking.
    pub fn take(&mut self, n: usize) -> Result<Vec<f32>, WeightError> {
        let end = self.offset + n * 4;
        if end > self.payload.len() {
            return Err(WeightError::SizeMismatch {
                expected: end,
                actual: self.payload.len(),
            });
        }
        let mut out = Vec::with_capacity(n);
        for chunk in self.payload[self.offset..end].chunks_exact(4) {
            let v = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if !v.is_finite() {
                return Err(WeightError::NonFinite(self.index));
            }
            out.push(v);
            self.index += 1;
        }
        self.offset = end;
        Ok(out)
    }

    pub fn is_exhausted(&self) -> bool {
        self.offset == self.payload.len()
    }
}

/// Serialize a header + payload. Used by tests to build synthetic models.
#[cfg(test)]
pub fn encode(config: &BertConfig, values: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + values.len() * 4);
    out.extend_from_slice(MAGIC);
    for v in [
        FORMAT_VERSION as usize,
        config.vocab_size,
        config.hidden_size,
        config.num_layers,
        config.num_heads,
        config.intermediate_size,
        config.max_position,
        config.type_vocab_size,
    ] {
        out.extend_from_slice(&(v as u32).to_le_bytes());
    }
    out.extend_from_slice(&(config.layer_norm_eps as f32).to_le_bytes());
    out.extend_from_slice(&DTYPE_F32.to_le_bytes());
    for v in values {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

#[cfg(test)]
pub(crate) fn tiny_config() -> BertConfig {
    BertConfig {
        vocab_size: 16,
        hidden_size: 8,
        num_layers: 2,
        num_heads: 2,
        intermediate_size: 12,
        max_position: 10,
        type_vocab_size: 2,
        layer_norm_eps: 1e-12,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_file() -> Vec<u8> {
        let cfg = tiny_config();
        encode(&cfg, &vec![0.5; cfg.param_count()])
    }

    #[test]
    fn parses_valid_file() {
        let bytes = valid_file();
        let file = WeightFile::parse(&bytes).unwrap();
        // eps is stored as f32, so compare it with a relative tolerance.
        let want = tiny_config();
        assert!((file.config.layer_norm_eps / want.layer_norm_eps - 1.0).abs() < 1e-6);
        assert_eq!(
            BertConfig {
                layer_norm_eps: want.layer_norm_eps,
                ..file.config.clone()
            },
            want
        );
        let mut r = file.reader();
        let all = r.take(tiny_config().param_count()).unwrap();
        assert!(all.iter().all(|&v| v == 0.5));
        assert!(r.is_exhausted());
    }

    #[test]
    fn param_count_matches_bert_tiny() {
        // Value cross-checked against tools/prepare_model.py output (4,320,256).
        let cfg = BertConfig {
            vocab_size: 30522,
            hidden_size: 128,
            num_layers: 2,
            num_heads: 2,
            intermediate_size: 512,
            max_position: 128,
            type_vocab_size: 2,
            layer_norm_eps: 1e-12,
        };
        assert_eq!(cfg.param_count(), 4_320_256);
    }

    #[test]
    fn rejects_short_and_bad_magic() {
        assert_eq!(
            WeightFile::parse(&[0; 10]).err(),
            Some(WeightError::TooShort(10))
        );
        let mut bytes = valid_file();
        bytes[0] = b'X';
        assert_eq!(WeightFile::parse(&bytes).err(), Some(WeightError::BadMagic));
    }

    #[test]
    fn rejects_truncated_payload() {
        let mut bytes = valid_file();
        bytes.truncate(bytes.len() - 4);
        assert!(matches!(
            WeightFile::parse(&bytes),
            Err(WeightError::SizeMismatch { .. })
        ));
    }

    #[test]
    fn rejects_trailing_bytes() {
        let mut bytes = valid_file();
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        assert!(matches!(
            WeightFile::parse(&bytes),
            Err(WeightError::SizeMismatch { .. })
        ));
    }

    #[test]
    fn rejects_wrong_version_and_dtype() {
        let mut bytes = valid_file();
        bytes[4] = 2;
        assert_eq!(
            WeightFile::parse(&bytes).err(),
            Some(WeightError::UnsupportedVersion(2))
        );
        let mut bytes = valid_file();
        bytes[40] = 1;
        assert_eq!(
            WeightFile::parse(&bytes).err(),
            Some(WeightError::UnsupportedDtype(1))
        );
    }

    #[test]
    fn rejects_heads_not_dividing_hidden() {
        let mut cfg = tiny_config();
        cfg.num_heads = 3;
        let bytes = encode(&cfg, &vec![0.0; cfg.param_count()]);
        assert!(matches!(
            WeightFile::parse(&bytes),
            Err(WeightError::InvalidConfig(_))
        ));
    }

    #[test]
    fn rejects_absurd_dimensions_without_overflow() {
        let mut bytes = valid_file();
        bytes[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(matches!(
            WeightFile::parse(&bytes),
            Err(WeightError::InvalidConfig(_))
        ));
    }

    #[test]
    fn rejects_non_finite_values() {
        let cfg = tiny_config();
        let mut values = vec![0.0; cfg.param_count()];
        values[3] = f32::NAN;
        let bytes = encode(&cfg, &values);
        let file = WeightFile::parse(&bytes).unwrap();
        assert_eq!(
            file.reader().take(cfg.param_count()).err(),
            Some(WeightError::NonFinite(3))
        );
    }
}
