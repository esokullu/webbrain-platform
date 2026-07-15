<?php

declare(strict_types=1);

final class WebBrainApiException extends RuntimeException
{
    public function __construct(string $message, public readonly int $status = 0, public readonly mixed $body = null)
    {
        parent::__construct($message, $status);
    }
}

final class WebBrainClient
{
    public function __construct(
        private readonly string $apiKey,
        private readonly string $baseUrl = 'https://webbrain.cloud',
        private readonly int $timeoutSeconds = 30,
    ) {
        if ($this->apiKey === '') {
            throw new InvalidArgumentException('apiKey is required');
        }
    }

    private function request(string $method, string $path, ?array $body = null): mixed
    {
        $handle = curl_init(rtrim($this->baseUrl, '/') . $path);
        $headers = ['Authorization: Bearer ' . $this->apiKey];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
        }
        curl_setopt_array($handle, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_HEADER => false,
        ]);
        if ($body !== null) {
            curl_setopt($handle, CURLOPT_POSTFIELDS, json_encode($body, JSON_THROW_ON_ERROR));
        }
        $raw = curl_exec($handle);
        if ($raw === false) {
            $message = curl_error($handle);
            curl_close($handle);
            throw new WebBrainApiException($message);
        }
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);
        $decoded = $raw === '' ? null : json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        if ($status < 200 || $status >= 300) {
            $message = is_array($decoded) && isset($decoded['error'])
                ? (string) $decoded['error']
                : "WebBrain API request failed with status {$status}";
            throw new WebBrainApiException($message, $status, $decoded);
        }
        return $decoded;
    }

    private static function id(string $value): string
    {
        return rawurlencode($value);
    }

    public function listBrowserSessions(): array
    {
        return $this->request('GET', '/api/browser-sessions')['browser_sessions'];
    }

    public function createBrowserSession(array $options = []): array
    {
        return $this->request('POST', '/api/browser-sessions', $options)['browser_session'];
    }

    public function getBrowserSession(string $sessionId): array
    {
        return $this->request('GET', '/api/browser-sessions/' . self::id($sessionId))['browser_session'];
    }

    public function updateBrowserSession(string $sessionId, ?string $displayName): array
    {
        $name = $displayName === null ? null : trim($displayName);
        return $this->request('PATCH', '/api/browser-sessions/' . self::id($sessionId), ['display_name' => $name ?: null])['browser_session'];
    }

    public function getBrowserProxy(string $sessionId): array
    {
        return $this->request('GET', '/api/browser-sessions/' . self::id($sessionId) . '/proxy')['proxy'];
    }

    public function updateBrowserProxy(string $sessionId, string|array|null $proxy): array
    {
        $body = is_array($proxy) ? ['proxy' => $proxy] : ['proxy_url' => $proxy];
        return $this->request(
            'PATCH',
            '/api/browser-sessions/' . self::id($sessionId) . '/proxy',
            $body,
        )['proxy'];
    }

    public function deleteBrowserSession(string $sessionId): array
    {
        return $this->request('DELETE', '/api/browser-sessions/' . self::id($sessionId))['browser_session'];
    }

    public function createConnectToken(string $sessionId, array $options = []): array
    {
        return $this->request('POST', '/api/browser-sessions/' . self::id($sessionId) . '/connect-token', $options);
    }

    public function waitForBrowserSession(string $sessionId, float $pollInterval = 2.0, float $timeout = 300.0): array
    {
        $deadline = microtime(true) + $timeout;
        do {
            $session = $this->getBrowserSession($sessionId);
            if (($session['runtime_ready'] ?? false) === true) {
                return $session;
            }
            if (in_array($session['status'] ?? '', ['failed', 'destroyed'], true)) {
                throw new WebBrainApiException("Browser session {$sessionId} entered {$session['status']}", body: $session);
            }
            if (microtime(true) >= $deadline) {
                throw new WebBrainApiException("Browser session {$sessionId} was not ready within {$timeout} seconds", body: $session);
            }
            usleep((int) ($pollInterval * 1_000_000));
        } while (true);
    }

    public function createRun(string $sessionId, string $task, array $options = []): array
    {
        if ($task === '') {
            throw new InvalidArgumentException('task is required');
        }
        $body = ['task' => $task, 'wait' => $options['wait'] ?? false];
        foreach (['timeout_ms', 'tab_id', 'output_schema'] as $key) {
            if (array_key_exists($key, $options)) {
                $body[$key] = $options[$key];
            }
        }
        return $this->request('POST', '/api/browser-sessions/' . self::id($sessionId) . '/runs', $body);
    }

    public function getRun(string $sessionId, string $runId): array
    {
        return $this->request('GET', '/api/browser-sessions/' . self::id($sessionId) . '/runs/' . self::id($runId));
    }

    public function abortRun(string $sessionId, string $runId): array
    {
        return $this->request('POST', '/api/browser-sessions/' . self::id($sessionId) . '/runs/' . self::id($runId) . '/abort', []);
    }

    public function waitForRun(string $sessionId, string $runId, float $pollInterval = 1.0, float $timeout = 120.0): array
    {
        $deadline = microtime(true) + $timeout;
        do {
            $run = $this->getRun($sessionId, $runId);
            if (in_array($run['status'] ?? '', ['completed', 'failed', 'aborted'], true)) {
                return $run;
            }
            if (microtime(true) >= $deadline) {
                throw new WebBrainApiException("Run {$runId} did not finish within {$timeout} seconds", body: $run);
            }
            usleep((int) ($pollInterval * 1_000_000));
        } while (true);
    }
}
