const platformIndex = process.argv.indexOf('--platforms');
const platform = platformIndex >= 0 ? process.argv[platformIndex + 1] : 'unknown';
process.stderr.write('fake skill diagnostic\n');
process.stdout.write('human readable prelude\n');
process.stdout.write(JSON.stringify({ results: { [platform]: { status: 'success', mediaId: `draft-${platform}` } } }) + '\n');
