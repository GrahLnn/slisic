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
    let like_ratio = counts[2] as f64 / (counts[0] + counts[1]) as f64;
    assert!(
        (0.20..0.30).contains(&repeat_ratio),
        "repeat ratio {repeat_ratio}"
    );
    assert!((7.4..8.6).contains(&like_ratio), "Like ratio {like_ratio}");
    assert_eq!(original, memory, "preparation never consumes coverage");
}

#[test]
fn centerless_recording_coverage_survives_restore_without_alias_multiplicity_bias() {
    let (snapshot, candidates) = fixture();
    let mut scoped = candidates[..2].to_vec();
    // Seven occurrences of one recording still own one recording opportunity.
    for _ in 0..6 {
        scoped.push(candidates[0].clone());
    }
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    memory.observe_track(&candidates[0].1, 0);
    memory.prune_expired(u64::MAX);
    let restored: PlaylistPlaybackTemporalMemory =
        serde_json::from_slice(&serde_json::to_vec(&memory).unwrap()).unwrap();
    let mut rng = SmallRng::seed_from_u64(2910);
    let mut counts = [0_usize; 2];
    for _ in 0..32_768 {
        let AudioStyleCenterlessSourceStatus::Ready(source, track, trace) =
            choose_audio_style_centerless_source(&snapshot, &scoped, &restored, &mut rng)
        else {
            panic!("both recordings must stay eligible")
        };
        assert_eq!(
            trace.probability, 1.0,
            "conditional choice conserves class mass"
        );
        assert_eq!(source.music.canonical_music_id, track.canonical_music_id);
        counts[usize::from(track.canonical_music_id == candidates[1].1.canonical_music_id)] += 1;
    }
    let ratio = counts[0] as f64 / counts[1] as f64;
    assert!((0.23..0.27).contains(&ratio), "heard/unheard ratio {ratio}");
    assert_eq!(restored, memory, "preparation cannot observe listening");
}

#[test]
fn recording_selection_preserves_likes_positive_floor_identity_and_permutation() {
    let (_, pairs) = fixture();
    let mut tracks = pairs.into_iter().map(|(_, t)| t).collect::<Vec<_>>();
    tracks.truncate(3);
    tracks[1].music_name = tracks[0].music_name.clone();
    tracks[2].liked = true;
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    for _ in 0..100 {
        memory.observe_track(&tracks[0], 0);
        memory.observe_track(&tracks[2], 0);
    }
    let original = tracks.clone();
    let mut rng = SmallRng::seed_from_u64(2911);
    let mut reverse_rng = rng.clone();
    let mut counts = [0_usize; 3];
    for _ in 0..65_536 {
        let index =
            choose_audio_style_recording_index(tracks.iter(), Some(&memory), &mut rng).unwrap();
        let reverse = choose_audio_style_recording_index(
            tracks.iter().rev(),
            Some(&memory),
            &mut reverse_rng,
        )
        .unwrap();
        assert_eq!(
            tracks[index].canonical_music_id,
            tracks[2 - reverse].canonical_music_id
        );
        counts[index] += 1;
    }
    assert!(
        counts[0] > 0,
        "even heavily played recordings keep positive probability"
    );
    let repeated = counts[0] as f64 / counts[1] as f64;
    let liked = counts[2] as f64 / (counts[0] + counts[1]) as f64;
    assert!((0.010..0.023).contains(&repeated), "floor ratio {repeated}");
    assert!((0.48..0.52).contains(&liked), "Like/cohort ratio {liked}");
    for (before, after) in original.iter().zip(&tracks) {
        assert_eq!(
            PlaybackTrackKey::from_track(before),
            PlaybackTrackKey::from_track(after)
        );
        assert_eq!(before.canonical_music_id, after.canonical_music_id);
        assert_eq!(before.liked, after.liked);
    }
}

#[test]
fn mixed_class_keeps_its_like_budget_without_a_second_recording_like_boost() {
    let (snapshot, mut candidates) = fixture();
    candidates[1].1.liked = true;
    candidates[1].0.music.liked = true;
    let shared = snapshot.symbolic_track_ordinal(&candidates[0].1).unwrap();
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    for _ in 0..100 {
        memory.observe_track(&candidates[0].1, 0);
        memory.observe_track(&candidates[1].1, 0);
    }
    let mut rng = SmallRng::seed_from_u64(2912);
    let mut counts = [0_usize; 3];
    for _ in 0..32_768 {
        let AudioStyleCenterlessSourceStatus::Ready(_, track, _) =
            choose_audio_style_centerless_source(&snapshot, &candidates, &memory, &mut rng)
        else {
            panic!("mixed classes retain all recording opportunities")
        };
        let index = if snapshot.symbolic_track_ordinal(&track) != Some(shared) {
            2
        } else {
            usize::from(track.liked)
        };
        counts[index] += 1;
    }
    let class_ratio = (counts[0] + counts[1]) as f64 / counts[2] as f64;
    let liked_within_class = counts[1] as f64 / (counts[0] + counts[1]) as f64;
    assert!(
        (7.6..8.4).contains(&class_ratio),
        "existing class Like ratio {class_ratio}"
    );
    assert!(
        (0.48..0.52).contains(&liked_within_class),
        "conditional Like mass {liked_within_class}"
    );
}

#[test]
fn continuation_recordings_share_persisted_progress_across_fresh_sessions_and_rollback() {
    let (snapshot, pairs) = fixture();
    let tracks = pairs.into_iter().map(|(_, t)| t).collect::<Vec<_>>();
    let mut memory = PlaylistPlaybackTemporalMemory::default();
    let mut counts = [4_u64, 0];
    for _ in 0..counts[0] {
        memory.observe_track(&tracks[0], 0);
    }
    for restart in 0..96 {
        memory = serde_json::from_slice(&serde_json::to_vec(&memory).unwrap()).unwrap();
        let mut session = AudioStyleSymbolicPlaybackSession::default();
        session.set_rng_seed_for_test(0x291000 + restart);
        let mut current = tracks[3].clone();
        for position in 0..3 {
            let before = memory.clone();
            let next = session
                .propose_next_with_temporal_memory(
                    &snapshot,
                    &current,
                    &tracks,
                    &[],
                    Some(&memory),
                    u64::MAX,
                )
                .unwrap();
            session.rollback_proposal().unwrap();
            let replay = session
                .propose_next_with_temporal_memory(
                    &snapshot,
                    &current,
                    &tracks,
                    &[],
                    Some(&memory),
                    u64::MAX,
                )
                .unwrap();
            assert_eq!(
                PlaybackTrackKey::from_track(&next.track),
                PlaybackTrackKey::from_track(&replay.track)
            );
            assert_eq!(memory, before, "pending and rollback are not observations");
            session.observe_active_track(&next.track).unwrap();
            if let Some(index) = tracks[..2]
                .iter()
                .position(|t| t.canonical_music_id == next.track.canonical_music_id)
            {
                counts[index] += 1;
            }
            memory.observe_track(&next.track, restart * 3 + position);
            current = next.track;
        }
    }
    assert!(
        counts[0] > 4 && counts[1] > 0,
        "both recordings must be heard: {counts:?}"
    );
    assert!(
        counts[0].abs_diff(counts[1]) <= 6,
        "soft progress must balance versions: {counts:?}"
    );
}
