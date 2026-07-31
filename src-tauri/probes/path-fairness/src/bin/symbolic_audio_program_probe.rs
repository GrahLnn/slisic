#[allow(dead_code)]
#[path = "../../../../src/domain/playlist_playback/path_fairness.rs"]
mod path_fairness;
#[path = "../../../../src/domain/playlist_playback/symbolic_program.rs"]
mod symbolic_program;

#[cfg(test)]
#[path = "../../../../src/domain/playlist_playback/path_fairness.test.rs"]
mod path_fairness_test;
#[cfg(test)]
#[path = "symbolic_audio_program_probe.test.rs"]
mod symbolic_audio_program_probe_test;
#[cfg(test)]
#[path = "../../../../src/domain/playlist_playback/symbolic_program.test.rs"]
mod symbolic_program_test;

use path_fairness::{FairnessConfig, load_stable_catalog};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use symbolic_program::{
    SymbolicCatalog, build_symbolic_playlist_scope_report, build_symbolic_program_report,
    candidate_relation_signature, compile_neural_program_atlas, ordered_track_key_signature,
    program_encoding_signature,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    let probe_mode = arguments.next().unwrap_or_else(|| "global".to_string());
    let metadata = load_track_metadata(&stable_path)?;
    let (raw_encoding, encoding) = load_program_encoding(&encoding_path, &metadata)?;
    if probe_mode == "migrate-stable-v2" {
        write_migrated_stable_model(&stable_path, &output_path, &raw_encoding, &metadata)?;
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "output": output_path,
                "status": "migration_candidate_written",
                "generation": metadata.generation,
                "track_count": metadata.track_keys.len(),
                "candidate_relation_signature":
                    raw_encoding.candidate_relation_signature,
                "program_encoding_signature":
                    raw_encoding.program_encoding_signature,
            }))
            .map_err(|error| format!("failed to encode migration summary: {error}"))?
        );
        return Ok(());
    }
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
    let report = match probe_mode.as_str() {
        "global" => {
            build_symbolic_program_report(&view, tracks_per_list, "747 - Ludwig Göransson")?
        }
        "playlist-scopes" => build_symbolic_playlist_scope_report(
            &view,
            &real_directory_scopes(&metadata.file_paths),
            "747 - Ludwig Göransson",
        )?,
        other => {
            return Err(format!(
                "unsupported probe mode `{other}`; expected `global`, `playlist-scopes`, or \
                 `migrate-stable-v2`"
            ));
        }
    };
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
            "summary": report["summary"],
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
    file_paths: Vec<String>,
}

fn load_track_metadata(path: &Path) -> Result<TrackMetadata, String> {
    let payload: StablePayload = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("failed to read `{}`: {error}", path.display()))?,
    )
    .map_err(|error| format!("failed to decode `{}`: {error}", path.display()))?;
    let mut track_keys = Vec::with_capacity(payload.state.indexed_tracks.len());
    let mut track_titles = Vec::with_capacity(payload.state.indexed_tracks.len());
    let mut file_paths = Vec::with_capacity(payload.state.indexed_tracks.len());
    for indexed in payload.state.indexed_tracks {
        track_keys.push(
            serde_json::to_string(&(
                indexed.key.music_url,
                &indexed.key.file_path,
                indexed.key.start_ms,
                indexed.key.end_ms,
            ))
            .map_err(|error| format!("failed to encode stable track key: {error}"))?,
        );
        track_titles.push(indexed.track.music_name);
        file_paths.push(indexed.key.file_path);
    }
    Ok(TrackMetadata {
        generation: payload.generation,
        track_keys,
        track_titles,
        file_paths,
    })
}

fn real_directory_scopes(file_paths: &[String]) -> Vec<(String, Vec<usize>)> {
    let mut scopes = std::collections::HashMap::<String, Vec<usize>>::new();
    for (ordinal, file_path) in file_paths.iter().enumerate() {
        let scope = Path::new(file_path)
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .to_string_lossy()
            .into_owned();
        scopes.entry(scope).or_default().push(ordinal);
    }
    let mut scopes = scopes.into_iter().collect::<Vec<_>>();
    scopes.sort_unstable_by(|left, right| {
        right
            .1
            .len()
            .cmp(&left.1.len())
            .then_with(|| left.0.cmp(&right.0))
    });
    scopes
}

fn load_program_encoding(
    path: &Path,
    metadata: &TrackMetadata,
) -> Result<(ProgramEncoding, LoadedProgramEncoding), String> {
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
        .iter()
        .flatten()
        .copied()
        .collect::<Vec<_>>();
    let candidate_signature = candidate_relation_signature(
        &metadata.track_keys,
        encoding.candidate_width,
        &candidate_rows,
    )?;
    if candidate_signature != encoding.candidate_relation_signature {
        return Err(
            "finite program encoding candidate signature differs from its rows".to_string(),
        );
    }
    let compilation = compile_neural_program_atlas(
        &metadata.track_keys,
        encoding.candidate_width,
        &candidate_rows,
    )?;
    let atlas = compilation.atlas.ok_or_else(|| {
        format!(
            "finite program encoding has unclosed candidate presentations: {:?}",
            compilation.unclosed_presentations
        )
    })?;
    let lineages = atlas
        .programs
        .iter()
        .map(|program| program.lineage.clone())
        .collect::<Vec<_>>();
    if lineages != encoding.program_lineages
        || program_encoding_signature(&atlas.programs) != encoding.program_encoding_signature
    {
        return Err("finite program encoding program signature differs from its rows".to_string());
    }
    let loaded = LoadedProgramEncoding {
        candidate_width: encoding.candidate_width,
        candidate_rows,
        candidate_relation_signature: encoding.candidate_relation_signature.clone(),
        program_lineages: encoding.program_lineages.clone(),
        program_encoding_signature: encoding.program_encoding_signature.clone(),
    };
    Ok((encoding, loaded))
}

// @forma implements architecture Domain.CrossRuntimeProgramEncoding as write_migrated_stable_model
// @forma summary Validate and persist one generation-owned finite encoding without audio re-encoding.
// @forma evidence symbolic_audio_program_probe_test::stable_migration_writes_v2_candidate_without_overwriting_source
fn write_migrated_stable_model(
    stable_path: &Path,
    output_path: &Path,
    encoding: &ProgramEncoding,
    metadata: &TrackMetadata,
) -> Result<(), String> {
    if stable_path == output_path {
        return Err("migration output must differ from the source stable model".to_string());
    }
    if output_path.exists() {
        return Err(format!(
            "migration output already exists: `{}`",
            output_path.display()
        ));
    }
    if encoding.stable_generation != metadata.generation
        || encoding.track_count != metadata.track_keys.len()
    {
        return Err("validated encoding no longer matches stable metadata".to_string());
    }
    let mut stable = serde_json::from_slice::<serde_json::Value>(
        &fs::read(stable_path)
            .map_err(|error| format!("failed to read `{}`: {error}", stable_path.display()))?,
    )
    .map_err(|error| format!("failed to decode `{}`: {error}", stable_path.display()))?;
    let stable_object = stable
        .as_object_mut()
        .ok_or_else(|| "stable model root must be an object".to_string())?;
    let state = stable_object
        .get_mut("state")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| "stable model state must be an object".to_string())?;
    state.insert(
        "symbolic_program_encoding".to_string(),
        serde_json::to_value(encoding)
            .map_err(|error| format!("failed to encode symbolic program: {error}"))?,
    );
    stable_object.insert(
        "version".to_string(),
        serde_json::Value::String("audio-style-stable-model-v2".to_string()),
    );
    let bytes = serde_json::to_vec(&stable)
        .map_err(|error| format!("failed to encode migrated stable model: {error}"))?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create migration output directory `{}`: {error}",
                parent.display()
            )
        })?;
    }
    let output_name = output_path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "stable.json".into());
    let temporary_path = output_path.with_file_name(format!(
        "{output_name}.{}.migration.tmp",
        std::process::id()
    ));
    fs::write(&temporary_path, bytes).map_err(|error| {
        format!(
            "failed to write migration candidate `{}`: {error}",
            temporary_path.display()
        )
    })?;
    fs::rename(&temporary_path, output_path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        format!(
            "failed to finalize migration candidate `{}`: {error}",
            output_path.display()
        )
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
