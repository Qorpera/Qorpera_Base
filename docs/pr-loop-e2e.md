# pr-loop end-to-end test

This is a throwaway file for testing the PR workflow (draft, link, ready,
exact-head review, pr-loop merge checks). It targets the branch
`test/pr-loop-base` and never lands on master.

## Leap years

The helper below implements the Gregorian leap-year rule for a year `y`:

```js
const isLeapYear = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
```

Pass the full year, such as `2024` rather than `24`. The helper returns
`true` if that year is a leap year and `false` if it is not.
