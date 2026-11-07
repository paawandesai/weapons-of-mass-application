`exclusive`, key `daily-run:<userId>:<date>`, `retryLimit: 0`; the `(user, date)` unique index on `runs` covers the time after it finished. Tick, cleanup and the job itself live in one file.
