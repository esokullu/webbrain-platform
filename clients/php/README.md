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
]);
$ready = $client->waitForBrowserSession($session['id']);
$downloads = $client->createDownloadsAccess($ready['id']);
// $downloads contains the private URL, username, password, limit, and expiry.
$client->updateBrowserProxy($ready['id'], [
    'domain' => 'p.webshare.io',
    'port' => 80,
    'username' => 'webshare-user',
    'password' => 'webshare-password',
]);
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
- `updateBrowserProxy($sessionId, $proxyUrlOrParts)`
- `deleteBrowserProxy($sessionId)`
- `waitForBrowserSession($sessionId, ...)`
- `deleteBrowserSession($sessionId)`
- `createRun($sessionId, $task, $options)`
- `getRun($sessionId, $runId)`
- `continueRun($sessionId, $runId, $task, $options)`
- `respondToRun($sessionId, $runId, $clarifyId, $answer)`
- `waitForRun($sessionId, $runId, ...)`
- `abortRun($sessionId, $runId)`
- `createConnectToken($sessionId, $options)`
- `createDownloadsAccess($sessionId)`

Failed HTTP requests throw `WebBrainApiException` with `status` and `body`
properties.
