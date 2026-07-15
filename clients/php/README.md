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

print_r($finished['result']);
```

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
- `waitForBrowserSession($sessionId, ...)`
- `deleteBrowserSession($sessionId)`
- `createRun($sessionId, $task, $options)`
- `getRun($sessionId, $runId)`
- `waitForRun($sessionId, $runId, ...)`
- `abortRun($sessionId, $runId)`
- `createConnectToken($sessionId, $options)`

Failed HTTP requests throw `WebBrainApiException` with `status` and `body`
properties.
