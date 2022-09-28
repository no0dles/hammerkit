# Release procedure
The release procedure can be started with a git tag.


```bash
npm version patch|minor|major|prerelease
git push origin --tags
```

In the Github CI pipeline builds the binaries needed for homebrew and publishes on docker hub / npm.

Once build the binaries/checksum can be updated on the [homebrew repo](https://github.com/no0dles/homebrew-hammerkit)
