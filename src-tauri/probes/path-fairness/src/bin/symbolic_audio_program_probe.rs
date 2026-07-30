#[allow(dead_code)]
#[path = "../../../../src/domain/playlist_playback/path_fairness.rs"]
mod path_fairness;
#[path = "../../../../src/domain/playlist_playback/symbolic_program.rs"]
mod symbolic_program;

#[cfg(test)]
#[path = "../../../../src/domain/playlist_playback/path_fairness.test.rs"]
mod path_fairness_test;
#[cfg(test)]
#[path = "../../../../src/domain/playlist_playback/symbolic_program.test.rs"]
mod symbolic_program_test;

use path_fairness::{FairnessConfig, load_stable_catalog};
use serde::Deserialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use symbolic_program::{
    SymbolicCatalog, build_symbolic_program_report, ordered_track_key_signature,
};

#[derive(Debug, Deserialize)]
struct StablePayload {
    generation: u64,
    state: StableState,
}

#[derive(Debug, Deserialize)]
struct StableState {
    indexed_tracks: Vec<StableIndexedTrack>,
}

#[derive(Debug, Deserialize)]
struct StableIndexedTrack {
    key: StableTrackKey,
    track: StableTrack,
}

#[derive(Debug, Deserialize)]
struct StableTrackKey {
    #[serde(default)]
    music_url: String,
    #[serde(default)]
    file_path: String,
    #[serde(default)]
    start_ms: u32,
    #[serde(default)]
    end_ms: u32,
}

#[derive(Debug, Deserialize)]
struct StableTrack {
    #[serde(default)]
    music_name: String,
}

#[derive(Debug, Deserialize)]
struct ProgramEncoding {
    schema: String,
    stable_generation: u64,
    track_count: usize,
    track_key_signature: String,
    candidate_width: usize,
    candidate_relation_signature: String,
    candidate_rows: Vec<Vec<usize>>,
    program_lineages: Vec<String>,
    program_encoding_signature: String,
}

fn main() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let stable_path = arguments
        .next()
        .map(PathBuf::from)
        .or_else(default_stable_path)
        .ok_or_else(|| "pass the stable.json path as the first argument".to_string())?;
    let encoding_path = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "pass the finite program encoding as the second argument".to_string())?;
    let output_path = arguments.next().map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(
            "outputs/audio_style_trajectory_dynamics/\
             rust_symbolic_audio_program_traversal_probe.json",
        )
    });
    let tracks_per_list = arguments
        .next()
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|error| format!("invalid tracks-per-list `{value}`: {error}"))
        })
        .transpose()?
        .unwrap_or(32);
    let metadata = load_track_metadata(&stable_path)?;
    let encoding = load_program_encoding(&encoding_path, &metadata)?;
    let catalog = load_stable_catalog(&stable_path, &FairnessConfig::default())?;
    if metadata.track_keys.len() != catalog.embeddings.len() / catalog.embedding_dimension {
        return Err("stable metadata and embedding track counts differ".to_string());
    }
    let view = SymbolicCatalog {
        generation: catalog.generation,
        embedding_dimension: catalog.embedding_dimension,
        embeddings: &catalog.embeddings,
        track_keys: &metadata.track_keys,
        track_titles: &metadata.track_titles,
        candidate_count: encoding.candidate_width,
        neighbors: &encoding.candidate_rows,
        candidate_relation_signature: &encoding.candidate_relation_signature,
        expected_program_lineages: &encoding.program_lineages,
        expected_program_encoding_signature: &encoding.program_encoding_signature,
    };
    let report = build_symbolic_program_report(&view, tracks_per_list, "747 - Ludwig Göransson")?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create probe output directory `{}`: {error}",
                parent.display()
            )
        })?;
    }
    fs::write(
        &output_path,
        serde_json::to_vec_pretty(&report)
            .map_err(|error| format!("failed to encode Rust probe report: {error}"))?,
    )
    .map_err(|error| {
        format!(
            "failed to write Rust probe report `{}`: {error}",
            output_path.display()
        )
    })?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "output": output_path,
            "status": report["status"],
            "program_structure": report["program_structure"],
            "cross_cycle_audit": report["cross_cycle_audit"],
            "reported_target": report["reported_target"],
            "acceptance": report["acceptance"],
        }))
        .map_err(|error| format!("failed to encode Rust probe summary: {error}"))?
    );
    Ok(())
}

struct TrackMetadata {
    generation: u64,
    track_keys: Vec<String>,
    track_titles: Vec<String>,
}

fn load_track_metadata(path: &Path) -> Result<TrackMetadata, String> {
    let payload: StablePayload = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("failed to read `{}`: {error}", path.display()))?,
    )
    .map_err(|error| format!("failed to decode `{}`: {error}", path.display()))?;
    let mut track_keys = Vec::with_capacity(payload.state.indexed_tracks.len());
    let mut track_titles = Vec::with_capacity(payload.state.indexed_tracks.len());
    for indexed in payload.state.indexed_tracks {
        track_keys.push(
            serde_json::to_string(&(
                indexed.key.music_url,
                indexed.key.file_path,
                indexed.key.start_ms,
                indexed.key.end_ms,
            ))
            .map_err(|error| format!("failed to encode stable track key: {error}"))?,
        );
        track_titles.push(indexed.track.music_name);
    }
    Ok(TrackMetadata {
        generation: payload.generation,
        track_keys,
        track_titles,
    })
}

fn load_program_encoding(
    path: &Path,
    metadata: &TrackMetadata,
) -> Result<LoadedProgramEncoding, String> {
    let encoding: ProgramEncoding = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("failed to read `{}`: {error}", path.display()))?,
    )
    .map_err(|error| format!("failed to decode `{}`: {error}", path.display()))?;
    if encoding.schema != "slisic.symbolic-audio-program-encoding.v1" {
        return Err(format!(
            "unsupported finite program encoding schema `{}`",
            encoding.schema
        ));
    }
    if encoding.stable_generation != metadata.generation {
        return Err("finite program encoding and stable generations differ".to_string());
    }
    if encoding.track_count != metadata.track_keys.len()
        || encoding.track_key_signature != ordered_track_key_signature(&metadata.track_keys)
    {
        return Err("finite program encoding and stable track order differ".to_string());
    }
    if encoding.candidate_width == 0
        || encoding.candidate_rows.len() != encoding.track_count
        || encoding
            .candidate_rows
            .iter()
            .any(|row| row.len() != encoding.candidate_width)
    {
        return Err("finite program encoding has a ragged candidate relation".to_string());
    }
    let candidate_rows = encoding
        .candidate_rows
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    Ok(LoadedProgramEncoding {
        candidate_width: encoding.candidate_width,
        candidate_rows,
        candidate_relation_signature: encoding.candidate_relation_signature,
        program_lineages: encoding.program_lineages,
        program_encoding_signature: encoding.program_encoding_signature,
    })
}

struct LoadedProgramEncoding {
    candidate_width: usize,
    candidate_rows: Vec<usize>,
    candidate_relation_signature: String,
    program_lineages: Vec<String>,
    program_encoding_signature: String,
}

fn default_stable_path() -> Option<PathBuf> {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("slisic/audio-style-stable-model/stable.json"))
}
