# How to write trial summaries

## What this is

Every file in this folder named `queue-001.md`, `queue-002.md` and so on
holds about 2,000 clinical trials taken from ClinicalTrials.gov. Each entry
has the trial's official name and a description of what is being tested,
both written for doctors. Your job is to add two sentences underneath, in
plain English, that a patient or their family could understand.

You are not summarising the official name. You are explaining what the study
is actually trying to find out.

## Setup, once

```bash
cd ~/Projects/trials
```

Open the folder in any text editor. VS Code or Sublime are both fine. The
files are large, so avoid TextEdit.

## Your working loop

**1. Before you start, always pull down the latest files:**

```bash
cd ~/Projects/trials && git pull origin main
```

This matters. A daily job edits these same files. If you skip this step you
will eventually get a merge conflict in a very large file, which is painful
to untangle.

**2. Open a file and work through it.** Each entry looks like this:

```
## NCT06585384
Etanercept Delivered Across the Blood-Brain Barrier With Focused Ultrasound...

Intervention: : Etanercept — administered with concurrent microbubble...
Link: https://clinicaltrials.gov/study/NCT06585384

SUMMARY:
```

Write your summary on the `SUMMARY:` line, after the colon and a space:

```
SUMMARY: A drug that blocks inflammation cannot help the brain if it cannot get past the blood-brain barrier. This early study pairs that drug with ultrasound and microbubbles that briefly open the barrier.
```

Keep it on one line. Do not press Enter in the middle of a summary.

**3. When you finish for the day, save and run:**

```bash
cd ~/Projects/trials && rm -f .git/index.lock && git add pipeline/pending-summaries && git commit -m "Add summaries" && git pull --rebase origin main && git push origin main
```

That publishes your work. Entries you completed are saved to the website's
database automatically and disappear from the file. Entries you left blank
stay exactly as they are.

You do not have to finish a file. Stop anywhere.

## How to write a good summary

Two sentences. Occasionally three. Aim for the level of a well-written
newspaper article, not a medical journal.

**Sentence one states the problem or the open question.** Why does this
trial exist? What is wrong with how things are done now?

**Sentence two says what the study does about it.**

Add a short sense of who it is for if that is not already obvious.

### Read the intervention text, not just the title

The title is usually unusable. The intervention text is where you find out
what is actually happening.

### Vary how you open

The fastest way to make 2,000 summaries unreadable is to start every one the
same way. Never write "This trial tests..." as a habit. Open on the problem,
the current treatment, the patient's situation, or the gap in knowledge.

### Name a drug only if the name means something

Write "semaglutide", "ketamine", "vitamin D", "aspirin". Do not write
"apatinib" or "trontinemab". For drugs nobody recognises, describe what the
drug does instead: "a daily pill that cuts off the tumour's blood supply".

### Do not use em dashes

Use a comma, a semicolon, or start a new sentence.

### Do not mention the trial phase, blinding, or how many people enrol

The website already shows those separately.

### Never invent

Everything you write must be supported by the title and intervention text in
front of you. If they do not tell you enough, leave the entry blank and move
on. A blank entry is fine. A wrong one is not.

## Examples

Good:

> Older patients with advanced stomach cancer often cannot tolerate standard
> chemotherapy at all. This study gives a daily oral drug that cuts off the
> tumour's blood supply as the only treatment.

> Most head injury patients sent for a CT scan turn out to have nothing on
> it, and the radiation is not free. This study shares a blood test result
> with the patient and the doctor before that decision is made.

> Arm recovery after a stroke needs far more repetitions than any therapy
> schedule can provide. This study gives patients a hand exoskeleton to use
> at home.

Bad, and why:

> This trial tests apatinib monotherapy in elderly patients with advanced
> gastric carcinoma.

Template opening, a drug name nobody knows, and "gastric carcinoma" is the
jargon we are supposed to be removing. It tells the reader nothing they did
not already see in the title.

## Checking your own work

Before you push, ask of each summary:

- Would someone with no medical background understand it?
- Does it explain *why* the trial exists, not just what it does?
- Did I start it differently from the one above it?
- Any em dashes?
- Is it all on one line?

## If something goes wrong

Do not try to fix a merge conflict on your own. Stop and ask.
