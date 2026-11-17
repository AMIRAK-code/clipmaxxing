"""Clip edges: context at the start, a finished thought at the end (steps/bounds.py)."""
from __future__ import annotations

import pytest

from klipz_worker.steps import bounds as B
from klipz_worker.steps.score import build_prompt
from klipz_worker.steps.segment import PAD_END, PAD_START, Candidate, Sentence, build_sentences


def S(text: str, s: float, e: float, spk: str | None = None) -> Sentence:
    return Sentence(s, e, text, [], spk)


def clip(sents: list[Sentence], i: int, j: int) -> tuple[float, float]:
    return sents[i].s - PAD_START, sents[j].e + PAD_END


def test_a_clip_that_answers_a_question_starts_with_the_question():
    sents = [S("Earlier stuff.", 0.0, 4.0), S("Why did the company fail?", 5.0, 7.0),
             S("Because nobody tested the product before launch.", 7.6, 11.0), S("They just shipped it.", 11.3, 13.0),
             S("And customers noticed immediately.", 13.4, 16.0), S("Sales dropped by half in a month.", 16.3, 25.0),
             S("Later stuff.", 30.0, 33.0)]
    start, end = clip(sents, 2, 5)
    r = B.refine_bounds(start, end, sents, 40.0)
    assert r.start == pytest.approx(5.0 - PAD_START) and r.end == pytest.approx(end)
    assert r.sentences[0].text.startswith("Why did") and "question" in r.reasons[0]


def test_a_clip_opening_on_a_connector_gets_the_sentence_it_continues():
    # (the added sentence fits the growth limit: 15 % of this 15 s clip is 2.25 s)
    sents = [S("We tried new pricing.", 1.5, 3.0), S("And it doubled our revenue in six weeks.", 3.4, 6.0),
             S("Nobody expected that.", 6.3, 8.0), S("The team was shocked by the numbers.", 8.4, 18.0), S("Next topic.", 25.0, 27.0)]
    start, end = clip(sents, 1, 3)
    r = B.refine_bounds(start, end, sents, 30.0)
    assert r.start == pytest.approx(1.5 - PAD_START) and r.reasons == ["starts with its context"]


def test_a_clean_start_and_a_finished_end_stay_as_they_are():
    sents = [S("Before.", 0.0, 2.0), S("Here is the secret to growth.", 5.0, 8.0), S("You talk to customers daily.", 8.3, 20.0),
             S("After.", 25.0, 27.0)]
    start, end = clip(sents, 1, 2)
    r = B.refine_bounds(start, end, sents, 30.0)
    assert (r.start, r.end, r.changed) == (pytest.approx(start), pytest.approx(end), False)


def test_a_clip_that_stops_mid_thought_runs_on_to_the_end_of_the_sentence():
    sents = [S("Start here with something clear.", 0.0, 5.0), S("The real reason it works is that", 5.3, 18.0),
             S("people trust what they can see.", 18.6, 20.5), S("Other topic.", 30.0, 32.0)]
    start, end = clip(sents, 0, 1)
    r = B.refine_bounds(start, end, sents, 40.0)
    assert r.end == pytest.approx(20.5 + PAD_END) and r.reasons == ["ends when the sentence ends"]


def test_a_short_payoff_right_after_the_clip_is_kept():
    sents = [S("We stopped running ads entirely.", 0.0, 4.0), S("Our signups went up instead of down.", 4.3, 18.0),
             S("That's why we never went back!", 18.4, 20.0), S("Unrelated.", 26.0, 28.0)]
    start, end = clip(sents, 0, 1)
    r = B.refine_bounds(start, end, sents, 30.0)
    assert r.end == pytest.approx(20.0 + PAD_END) and r.reasons == ["ends on its payoff"]


def test_edges_never_grow_past_the_limit_or_across_speakers_or_long_pauses():
    # finishing the sentence would add 9 s to a 20 s clip: more than 15 % / 6 s, so the end stays
    sents = [S("A clear opening line here.", 0.0, 5.0), S("and then the thing that happened was", 5.3, 20.0),
             S("really long and only finished much later on.", 20.3, 29.0)]
    start, end = clip(sents, 0, 1)
    assert not B.refine_bounds(start, end, sents, 40.0).changed
    # a question asked by someone else, or after a long pause, is not pulled in
    other = [S("Why did it fail?", 0.0, 2.0, "S2"), S("Because nobody tested it at all.", 2.5, 18.0, "S1")]
    assert not B.refine_bounds(*clip(other, 1, 1), other, 30.0).changed
    paused = [S("Why did it fail?", 0.0, 2.0), S("Because nobody tested it at all.", 6.0, 22.0)]
    assert not B.refine_bounds(*clip(paused, 1, 1), paused, 30.0).changed


def test_ai_prompt_shows_what_was_said_just_before():
    words = [{"w": w, "s": i * 0.5, "e": i * 0.5 + 0.4} for i, w in enumerate("What happened next? It went viral.".split())]
    sents = build_sentences(words)
    c = Candidate(1.0, 3.0, sents[1:], before=sents[0].text)
    prompt = build_prompt([c])
    assert "[before, not in the clip] What happened next?" in prompt
    assert "[before" not in build_prompt([Candidate(1.0, 3.0, sents[1:])])
