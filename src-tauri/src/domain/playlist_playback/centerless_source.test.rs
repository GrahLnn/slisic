use super::*;

fn fixture() -> (
    AudioStyleModelSnapshot,
    Vec<(PlaylistPlaybackTrackSource, PlaybackTrack)>,
) {
    let pairs = (0..4)
        .map(|index| {
            let track = PlaybackTrack {
                playlist_name: "scope".into(),
                music_name: format!("recording-{index}"),
                canonical_music_id: format!("recording:{index}"),
                music_url: format!("source:{index}"),
                file_path: PathBuf::from(format!("{index}.m4a")),
                start_ms: 0,
                end_ms: 60_000,
                source_music: None,
                liked: false,
                loudness_profile: None,
            };
            (
                PlaylistPlaybackTrackSource {
                    collection_folder: "scope".into(),
                    music: playback_track_source_music_from_track(&track),
                },
                track,
            )
        })
        .collect::<Vec<_>>();
    let snapshot = AudioStyleModelSnapshot::from_test_acoustic_indexed_embeddings(
        1,
        pairs.iter().enumerate().map(|(index, (_, track))| {
            let mut embedding = vec![0.0; AUDIO_STYLE_EMBEDDING_WIDTH];
            embedding[index] = 1.0;
            (
                track.clone(),
                embedding,
                Some(format!("content-{}", index.saturating_sub(1))),
                None,
            )
        }),
    );
    (snapshot, pairs)
}

#[test]
fn centerless_scope_uses_valid_alternative_when_global_representative_is_absent() {
    let (snapshot, candidates) = fixture();
    let shared_class = snapshot.symbolic_track_ordinal(&candidates[0].1).unwrap();
    assert_eq!(
        snapshot.symbolic_track_ordinal(&candidates[1].1),
        Some(shared_class)
    );
    let representative = snapshot
        .symbolic_playlist_track_representative_keys()
        .into_iter()
        .find(|key| {
            key.music_url == candidates[0].1.music_url || key.music_url == candidates[1].1.music_url
        })
        .unwrap();
    let scoped = candidates
        .into_iter()
        .filter(|(_, t)| t.music_url != representative.music_url)
        .collect::<Vec<_>>();
    let memory = PlaylistPlaybackTemporalMemory::default();
    let mut rng = SmallRng::seed_from_u64(2210);
    let mut observed = HashSet::new();
    for _ in 0..128 {
        let AudioStyleCenterlessSourceStatus::Ready(source, track, trace) =
            choose_audio_style_centerless_source(&snapshot, &scoped, &memory, &mut rng)
        else {
            panic!("valid scoped classes must remain eligible")
        };
        assert_eq!(trace.candidate_count, 3);
        assert_eq!(source.music.canonical_music_id, track.canonical_music_id);
        assert_eq!(trace.probability, 1.0 / 3.0);
        observed.insert(snapshot.symbolic_track_ordinal(&track).unwrap());
    }
    assert_eq!(observed.len(), 3);
    assert!(observed.contains(&shared_class));
}

#[test]
fn centerless_soft_coverage_preserves_positive_repeat_probability_and_like_boost() {
    let (snapshot, candidates) = fixture();
    let mut scoped = candidates.into_iter().skip(1).collect::<Vec<_>>();
    scoped[2].1.liked = true;
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe_track(&scoped[0].1, 0);
    let original = memory.clone();
    let mut rng = SmallRng::seed_from_u64(2211);
    let mut counts = [0_usize; 3];
    for _ in 0..32_768 {
        let AudioStyleCenterlessSourceStatus::Ready(_, track, trace) =
            choose_audio_style_centerless_source(&snapshot, &scoped, &memory, &mut rng)
        else {
            panic!("positive weights must be selectable")
        };
        assert!(trace.probability > 0.0);
        let index = scoped
            .iter()
            .position(|(_, t)| t.canonical_music_id == track.canonical_music_id)
            .unwrap();
        counts[index] += 1;
    }
    assert!(counts[0] > 0);
    let repeat_ratio = counts[0] as f64 / counts[1] as f64;
    let like_ratio = counts[2] as f64 / counts[1] as f64;
    assert!(
        (0.20..0.30).contains(&repeat_ratio),
        "repeat ratio {repeat_ratio}"
    );
    assert!(
        (14.5..17.5).contains(&like_ratio),
        "Like ratio {like_ratio}"
    );
    assert_eq!(original, memory, "preparation never consumes coverage");
}
