# Does a running counter hold people, or is it the hook line?

Written and committed BEFORE any video in this experiment was published.
The git timestamp on this file is the claim.

## Question

Three of my published Shorts all used a running accumulation counter and
averaged 18.5% viewed on YouTube (23.1 / 21.0 / 11.5, n=1 each). I don't
know whether the counter did that work or the hook sentence did.

## Varied

Format, three levels:

- `stat-counter-rise` (accumulating number)
- `countdown-clock` (deadline, counting down)
- `cold-open-question` (no counter at all)

## Held constant

- Content axis: `personal-body`
- Clip length: 30s ± 2s

  The three formats were retimed to 30s for this experiment. Their earlier
  durations (10s, 12s, 10s) were arbitrary — I picked them when generating the
  library and had no evidence behind the choice. 30s matches what the channel
  actually publishes: the three videos in the Question section are all 31s. The
  rest of the library is still 8–14s, and those durations are equally arbitrary.
- Audio: none
- Posting time of day
- Caption and hashtag pattern
- Cover frame: manually selected at 2–3s, never frame 0
- Platforms: YouTube Shorts, TikTok, Instagram Reels — same cut per platform
  where length allows; per-platform duration recorded separately

## Design

Interleaved: A-B-C-A-B-C… Never all of one format in a block.
Reason: channel growth and algorithm state drift over weeks and would be
confounded with format if the formats were blocked.

## Primary outcome

`avg_pct_viewed` on YouTube, compared WITHIN platform only.
Never divided across platforms — view and watch definitions differ.

## Secondary, descriptive only — NOT decisive

- views at 24h
- TikTok watched-full %

Reason: in the data I already have, retention and reach moved in opposite
directions. Reach is dominated by distribution, not by the video.

## Sample size and stopping rule

n = 5 per format, 15 videos total.
Analysis happens only after all 15 are published AND 7 days have passed
since the last one. I will not look at the ranking and stop early.
Every published video in the series counts, including ones that flop.
No exclusions, no re-runs.

## Prediction

I expect `stat-counter-rise` to hold the most, `countdown-clock` second,
`cold-open-question` least.

Two things this prediction is *not*, recorded now so they cannot be quietly
reinterpreted after the result:

**It is not a test of the counter mechanism.** The three levels differ in their
whole scene structure, not only in whether a counter is present. Each carries
its own hook sentence, its own pacing and its own payoff. If
`stat-counter-rise` wins, the supported conclusion is "this format held more
attention than those two", not "the counter rather than the hook line did the
work". Isolating the counter would need a fourth level: the same hook sentence
with the counter removed and nothing else changed. That experiment is not this
one, and the title of this file overstates what the design can answer.

**The 18.5% is not a baseline for it.** Those three videos used a format that is
not in this library, and they spanned three different content axes — 23.1% was
`personal-body`, 11.5% was `physical-world`. This experiment holds the axis
constant at `personal-body`, which is the right call, but it means the earlier
average mixes an axis effect into a number that would otherwise look like a
format effect. Comparing a result here against 18.5% would be comparing two
different things.

## Expected precision

Stated in advance, because a result is easy to over-read after the fact.

The three counter videos already published spread from 11.5% to 23.1% — about
11.6 points — with the format held constant. Whatever produces that spread
(topic, thumbnail, posting luck, distribution) will still be present here.
At n=5 per level, a difference of a few points between formats is inside that
noise and should not be called a finding. This experiment is powered to detect
a large difference, not a subtle one, and if the result is subtle the honest
report is "too close to call at n=5".

## What would falsify it

If `cold-open-question` matches or beats either counter format, the reasoning
above is wrong and the counter is not the mechanism.

If all three land within a few points of each other at n=5, the honest
conclusion is that format choice among these three does not move retention
much, and I will publish that.

## Status

Not started. No videos published yet.
