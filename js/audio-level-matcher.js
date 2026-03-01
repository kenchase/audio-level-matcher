/**
 * Audio Level Matcher — Frontend Script
 * ──────────────────────────────────────
 *
 * Automatically normalizes the loudness of every <audio> element on the page.
 * Designed for audio engineers evaluating mixes — level correction must be
 * accurate from the very first sample to prevent loudness bias.
 *
 * HOW IT WORKS
 * 1. On page load, discovers all <audio> elements.
 * 2. For each, creates a Web Audio graph: source → GainNode → destination.
 * 3. Immediately fetches each file, decodes it offline, and measures RMS loudness.
 * 4. Sets the GainNode to the computed correction BEFORE the user presses play.
 * 5. When the user presses play, the level is already correct — no ramp, no delay.
 *
 * EAGER ANALYSIS
 * All tracks are analyzed on page load in parallel. This means each audio file
 * is downloaded twice (once by the browser for playback, once by this script
 * for analysis), but it guarantees the gain is ready before anyone hits play.
 * For critical A/B listening this tradeoff is essential.
 *
 * GRACEFUL DEGRADATION
 * If anything fails (CORS error, decode failure, AudioContext unavailable),
 * the audio element plays at its original level — the user hears no difference
 * from a normal WordPress audio player.
 *
 * CONFIGURATION
 * Options are passed from PHP via wp_localize_script as the global `almConfig` object.
 * See audio-level-matcher.php for the full list and defaults.
 */
( function () {
	'use strict';

	/* ── Read config from PHP (or fall back to sensible defaults) ── */
	var cfg = ( typeof almConfig !== 'undefined' ) ? almConfig : {};

	var CONFIG = {
		targetRmsDbfs:    parseFloat( cfg.targetRmsDbfs )    || -18,
		maxGainDb:        parseFloat( cfg.maxGainDb )        || 12,
		minGainDb:        parseFloat( cfg.minGainDb )        || -12,
		analysisDuration: parseInt( cfg.analysisDuration, 10 ) || 10,
		gainRampTime:     parseFloat( cfg.gainRampTime )     || 0.05,
		mutualExclusion:  ( cfg.mutualExclusion !== undefined ) ? !!cfg.mutualExclusion : true,
	};

	/* ── Derived constants ── */
	var MAX_GAIN_LIN = Math.pow( 10, CONFIG.maxGainDb / 20 );
	var MIN_GAIN_LIN = Math.pow( 10, CONFIG.minGainDb / 20 );
	var TARGET_LIN   = Math.pow( 10, CONFIG.targetRmsDbfs / 20 );

	/* ── Utility functions ── */
	function clamp( v, lo, hi ) { return Math.min( Math.max( v, lo ), hi ); }
	function toDb( x ) { return 20 * Math.log10( x ); }

	/* ── Single shared AudioContext ── */
	var audioCtx = null;
	function getCtx() {
		if ( ! audioCtx ) {
			audioCtx = new ( window.AudioContext || window.webkitAudioContext )();
		}
		return audioCtx;
	}

	/**
	 * Per-player state.
	 * Map<HTMLAudioElement, {
	 *   source:   MediaElementAudioSourceNode,
	 *   gain:     GainNode,
	 *   analyzed: boolean,
	 *   normGain: number   // linear gain multiplier (1.0 = no change)
	 * }>
	 */
	var players = new Map();

	/* ──────────────────────────────────────────────────────────────
	 * RMS Analysis
	 *
	 * Fetches the audio file, decodes it to PCM, and measures the
	 * RMS loudness of the first N seconds across all channels.
	 *
	 * Returns a linear gain value to reach the target level,
	 * clamped within the configured dB limits.
	 * ────────────────────────────────────────────────────────────── */
	function analyzeRMS( url ) {
		return new Promise( function ( resolve ) {
			var ctx = getCtx();

			fetch( url, { cache: 'default' } )
				.then( function ( res ) {
					if ( ! res.ok ) throw new Error( 'HTTP ' + res.status );
					return res.arrayBuffer();
				} )
				.then( function ( buf ) {
					return ctx.decodeAudioData( buf );
				} )
				.then( function ( audioBuf ) {
					var sr   = audioBuf.sampleRate;
					var N    = Math.min( audioBuf.length, sr * CONFIG.analysisDuration );
					var nCh  = audioBuf.numberOfChannels;

					/*
					 * Proper multi-channel RMS:
					 * Sum squared samples across all channels independently,
					 * then divide by (samples × channels). This avoids
					 * mono-sum cancellation on wide-stereo or out-of-phase material.
					 */
					var sumSq = 0;
					for ( var ch = 0; ch < nCh; ch++ ) {
						var data = audioBuf.getChannelData( ch ).subarray( 0, N );
						for ( var i = 0; i < N; i++ ) {
							sumSq += data[ i ] * data[ i ];
						}
					}
					var rms = Math.sqrt( sumSq / ( N * nCh ) ) || 1e-10;

					/* Compute and clamp gain correction. */
					var rawGain  = TARGET_LIN / rms;
					var normGain = clamp( rawGain, MIN_GAIN_LIN, MAX_GAIN_LIN );

					resolve( normGain );
				} )
				.catch( function () {
					/* On any failure, fall back to unity gain (no change). */
					resolve( 1.0 );
				} );
		} );
	}

	/* ──────────────────────────────────────────────────────────────
	 * Mutual exclusion — pause all other players.
	 * ────────────────────────────────────────────────────────────── */
	function pauseOthers( exceptEl ) {
		if ( ! CONFIG.mutualExclusion ) return;
		players.forEach( function ( _state, el ) {
			if ( el !== exceptEl && ! el.paused ) {
				el.pause();
			}
		} );
	}

	/* ──────────────────────────────────────────────────────────────
	 * Resolve the effective source URL from an <audio> element.
	 * Handles both src attribute and nested <source> elements.
	 * ────────────────────────────────────────────────────────────── */
	function getSourceUrl( el ) {
		if ( el.src ) return el.src;
		var sourceEl = el.querySelector( 'source[src]' );
		return sourceEl ? sourceEl.src : null;
	}

	/* ──────────────────────────────────────────────────────────────
	 * Register a single <audio> element.
	 *
	 * 1. Wires the Web Audio graph.
	 * 2. Kicks off RMS analysis immediately (eager — no waiting for play).
	 * 3. Sets the gain BEFORE the user ever presses play.
	 * 4. Attaches a play handler for mutual exclusion and AudioContext resume.
	 * ────────────────────────────────────────────────────────────── */
	function registerPlayer( el ) {
		/* Skip if already registered (e.g., script loaded twice). */
		if ( players.has( el ) ) return;

		/* Skip elements without a source — nothing to analyze. */
		var url = getSourceUrl( el );
		if ( ! url ) return;

		try {
			var ctx    = getCtx();
			var source = ctx.createMediaElementSource( el );
			var gain   = ctx.createGain();

			/* Wire: source → gain → speakers. */
			source.connect( gain ).connect( ctx.destination );

			var state = {
				source:   source,
				gain:     gain,
				analyzed: false,
				normGain: 1.0,  // Unity gain until analysis completes.
			};
			players.set( el, state );

		} catch ( e ) {
			/*
			 * createMediaElementSource can throw if:
			 * - CORS is not configured (tainted source).
			 * - The element was already connected to a different context.
			 * In either case, do nothing — audio plays normally.
			 */
			return;
		}

		/*
		 * EAGER ANALYSIS: Start immediately on registration, not on play.
		 * The gain is set on the GainNode as soon as analysis completes.
		 * Since the GainNode is already in the signal chain, the correction
		 * will be active whenever the user eventually presses play.
		 */
		analyzeRMS( url ).then( function ( normGain ) {
			var st = players.get( el );
			if ( ! st ) return;
			st.normGain = normGain;
			st.analyzed = true;

			/*
			 * Set gain immediately on the node (no ramp needed here —
			 * nothing is playing yet, so there's no audible transition).
			 */
			st.gain.gain.value = normGain;
		} );

		/*
		 * Play handler: only needed for mutual exclusion and
		 * resuming the AudioContext on mobile (user gesture required).
		 */
		el.addEventListener( 'play', function () {
			/* Resume context if suspended (required on mobile / autoplay policy). */
			if ( audioCtx && audioCtx.state === 'suspended' ) {
				audioCtx.resume();
			}

			pauseOthers( el );
		} );
	}

	/* ──────────────────────────────────────────────────────────────
	 * Initialization
	 *
	 * Discovers all <audio> elements currently in the DOM and
	 * immediately begins analyzing each one. Also watches for
	 * dynamically added players via MutationObserver.
	 * ────────────────────────────────────────────────────────────── */
	function init() {
		/* Register and analyze all existing audio elements. */
		var audios = document.querySelectorAll( 'audio' );
		for ( var i = 0; i < audios.length; i++ ) {
			registerPlayer( audios[ i ] );
		}

		/*
		 * Watch for new <audio> elements added after page load.
		 * Covers AJAX content, page builders, and dynamic shortcodes.
		 * New players are analyzed eagerly as soon as they appear.
		 */
		if ( typeof MutationObserver !== 'undefined' ) {
			var observer = new MutationObserver( function ( mutations ) {
				for ( var m = 0; m < mutations.length; m++ ) {
					var added = mutations[ m ].addedNodes;
					for ( var n = 0; n < added.length; n++ ) {
						var node = added[ n ];
						if ( node.nodeType !== 1 ) continue;

						if ( node.tagName === 'AUDIO' ) {
							registerPlayer( node );
						}
						var nested = node.querySelectorAll ? node.querySelectorAll( 'audio' ) : [];
						for ( var j = 0; j < nested.length; j++ ) {
							registerPlayer( nested[ j ] );
						}
					}
				}
			} );

			observer.observe( document.body, { childList: true, subtree: true } );
		}
	}

	/* ── Start ── */
	if ( document.readyState === 'loading' ) {
		document.addEventListener( 'DOMContentLoaded', init );
	} else {
		init();
	}

} )();
