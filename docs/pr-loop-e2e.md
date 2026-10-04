# pr-loop end-to-end test

This is a throwaway file for testing pr-loop, the automation that reviews
ready pull requests, sends the review to the owning thread, re-reviews after
every push, and merges once the pull request is approved and tested.

It targets the branch `test/pr-loop-base` and never lands on master.

## Leap years

The helper below implements the Gregorian calendar rule for leap years:

```js
const isLeapYear = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
```

Use it wherever a date calculation needs to know whether February has 29 days.
