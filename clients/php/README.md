# WebBrain Cloud client for PHP

Dependency-free client for PHP 8.1 and newer. The PHP cURL extension must be
enabled.

## Setup

Copy [`WebBrainClient.php`](WebBrainClient.php) into your project and set your
dashboard API key:

```bash
export WEBBRAIN_API_KEY='wbp_your_key_here'
```

## Create a browser and run a task

```php
<?php

require_once __DIR__ . '/WebBrainClient.php';

$client = new WebBrainClient(getenv('WEBBRAIN_API_KEY') ?: '');
$session = $client->createBrowserSession([
    'display_name' => 'Research',
    'type' => 'normal', // or 'incognito', matching the dashboard
    'proxy_enabled' => false,
]);
$ready = $client->waitForBrowserSession($session['id']);
$downloads = $client->createDownloadsAccess($ready['id']);
// $downloads contains the private URL, username, password, limit, and expiry.
$client->updateBrowserProxy($ready['id'], true);
$run = $client->createRun(
    $ready['id'],
    'Open example.com and return the page title',
);
$finished = $client->waitForRun($ready['id'], $run['run_id']);
if ($finished['status'] === 'needs_user_input') {
    $client->respondToRun(
        $ready['id'],
        $run['run_id'],
        $finished['pending_input']['clarify_id'],
        'Work',
    );
    $finished = $client->waitForRun($ready['id'], $run['run_id']);
}

print_r($finished['result']);

$followUp = $client->continueRun(
    $ready['id'],
    $finished['run_id'],
    'Now open the first link and summarize it',
);
print_r($client->waitForRun($ready['id'], $followUp['run_id'])['result']);
```

`continueRun` creates a child run with `parent_run_id` and reuses the same tab
and WebBrain conversation. Append later turns to the newest child run.

Pause destroys the Droplet but retains the fixed 2 GiB Chrome profile volume;
resume attaches it to a new Droplet. Shared Downloads stay available:

```php
$client->pauseBrowserSession($ready['id']);
$client->listDownloads($ready['id']);
$client->resumeBrowserSession($ready['id']);
$client->waitForBrowserSession($ready['id']);
```

Use `resetBrowserSession` to hard power-cycle the current Droplet without
deleting the browser session or profile. Any active run is marked failed:

```php
$client->resetBrowserSession($ready['id']);
$client->waitForBrowserSession($ready['id']);
```

## Downloads transfers

The transfer helpers stream file bodies instead of buffering them in memory.
Reuse one access response for a batch of operations:

```php
$access = $client->createDownloadsAccess($ready['id']);

$uploaded = $client->uploadDownloadsFile(
    $ready['id'],
    './report.pdf',
    'report.pdf',
    $access,
    true,
);
echo $uploaded['name']; // May be "report (1).pdf" on a collision.
var_dump($uploaded['browser_path']); // Real path in this ready browser.
var_dump($uploaded['browser_ready']);

$listing = $client->listDownloads($ready['id'], '', $access);
print_r($listing['entries']);

$client->downloadDownloadsFile(
    $ready['id'],
    $uploaded['name'],
    './saved/report.pdf',
    $access,
);
$client->downloadDownloadsFile(
    $ready['id'],
    $uploaded['name'],
    './saved/report-first-1KiB',
    $access,
    'bytes=0-1023',
);
```

The final `true` uploads directly to the ready, running browser and returns its
absolute Downloads path. Omit it to use durable shared object storage; that
default remains accessible while paused but returns `browser_path: null`.

If `$access` is omitted, each helper calls `createDownloadsAccess` itself. A
download will not replace an existing local file unless `$overwrite` is
explicitly `true`. Remote paths reject traversal, dotfile, and control
character segments.

## Structured output

```php
$run = $client->createRun($session['id'], 'Return the title and visible links', [
    'output_schema' => [
        'title' => 'string',
        'links' => 'string[]',
    ],
]);
```

## Main methods

- `listBrowserSessions()`
- `createBrowserSession($options)`
- `getBrowserSession($sessionId)`
- `updateBrowserSession($sessionId, $displayName)`
- `getBrowserProxy($sessionId)`
- `updateBrowserProxy($sessionId, $enabled)`
- `deleteBrowserProxy($sessionId)`
- `waitForBrowserSession($sessionId, ...)`
- `deleteBrowserSession($sessionId)`
- `resetBrowserSession($sessionId)`
- `pauseBrowserSession($sessionId)`
- `resumeBrowserSession($sessionId)`
- `createWorkflow($name, $sourceSessionId, $sourceRunId)`
- `listWorkflows(...)` / `getWorkflow($workflowId)`
- `importWorkflow($definition, $name)` / `exportWorkflow($workflowId)`
- `renameWorkflow($workflowId, $name)` / `deleteWorkflow($workflowId)`
- `createRun($sessionId, $task, $options)`
- `createWorkflowRun($sessionId, $workflowId, $parameters, $options)`
- `getRun($sessionId, $runId)`
- `continueRun($sessionId, $runId, $task, $options)`
- `respondToRun($sessionId, $runId, $clarifyId, $answer)`
- `waitForRun($sessionId, $runId, ...)`
- `abortRun($sessionId, $runId)`
- `createConnectToken($sessionId, $options)`
- `createDownloadsAccess($sessionId)`
- `listDownloads($sessionId, $path, $access)`
- `uploadDownloadsFile($sessionId, $localPath, $remotePath, $access)`
- `downloadDownloadsFile($sessionId, $remotePath, $destinationPath, $access, $range, $overwrite)`

Failed HTTP requests throw `WebBrainApiException` with `status` and `body`
properties.
