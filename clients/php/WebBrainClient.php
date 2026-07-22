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
        $response = $this->request('POST', '/api/browser-sessions', $options);
        $session = $response['browser_session'];
        if (array_key_exists('webbrain_config_result', $response)) {
            $session['webbrain_config_result'] = $response['webbrain_config_result'];
        }
        return $session;
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

    public function updateBrowserProxy(string $sessionId, bool $enabled = true): array
    {
        return $this->request(
            'PATCH',
            '/api/browser-sessions/' . self::id($sessionId) . '/proxy',
            ['proxy_enabled' => $enabled],
        )['proxy'];
    }

    public function deleteBrowserProxy(string $sessionId): array
    {
        return $this->request('DELETE', '/api/browser-sessions/' . self::id($sessionId) . '/proxy')['proxy'];
    }

    public function deleteBrowserSession(string $sessionId): array
    {
        return $this->request('DELETE', '/api/browser-sessions/' . self::id($sessionId))['browser_session'];
    }

    public function pauseBrowserSession(string $sessionId): array
    {
        return $this->request('POST', '/api/browser-sessions/' . self::id($sessionId) . '/pause', [])['browser_session'];
    }

    public function resumeBrowserSession(string $sessionId): array
    {
        return $this->request('POST', '/api/browser-sessions/' . self::id($sessionId) . '/resume', [])['browser_session'];
    }

    public function resetBrowserSession(string $sessionId): array
    {
        return $this->request('POST', '/api/browser-sessions/' . self::id($sessionId) . '/reset', [])['browser_session'];
    }

    public function createConnectToken(string $sessionId, array $options = []): array
    {
        return $this->request('POST', '/api/browser-sessions/' . self::id($sessionId) . '/connect-token', $options);
    }

    public function createDownloadsAccess(string $sessionId): array
    {
        return $this->request('POST', '/api/browser-sessions/' . self::id($sessionId) . '/downloads-access', []);
    }

    public function listDownloads(string $sessionId, string $path = '', ?array $access = null): array
    {
        $downloadsAccess = $this->downloadsAccess($sessionId, $access);
        return $this->downloadsRequest(
            $downloadsAccess,
            $this->downloadsUrl($downloadsAccess, $path, true),
            headers: ['Accept: application/json'],
        );
    }

    public function uploadDownloadsFile(
        string $sessionId,
        string $localPath,
        ?string $remotePath = null,
        ?array $access = null,
        bool $browserLocal = false,
    ): array {
        if (!is_file($localPath)) {
            throw new InvalidArgumentException('localPath must be a regular file');
        }
        $size = filesize($localPath);
        if ($size === false) {
            throw new WebBrainApiException('Could not determine the local file size');
        }
        $downloadsAccess = $this->downloadsAccess($sessionId, $access);
        $uploadLimit = $downloadsAccess['upload_limit_bytes'] ?? null;
        if (is_int($uploadLimit) && $size > $uploadLimit) {
            throw new InvalidArgumentException("File exceeds the {$uploadLimit}-byte Downloads upload limit");
        }
        $source = fopen($localPath, 'rb');
        if ($source === false) {
            throw new WebBrainApiException('Could not open the local file');
        }
        try {
            return $this->downloadsRequest(
                $downloadsAccess,
                $this->downloadsUrl($downloadsAccess, $remotePath ?? basename($localPath)),
                method: 'PUT',
                input: $source,
                inputSize: $size,
                headers: [
                    'Accept: application/json',
                    'Content-Type: application/octet-stream',
                    ...($browserLocal ? ['X-WebBrain-Upload-Target: browser'] : []),
                ],
            );
        } finally {
            fclose($source);
        }
    }

    public function downloadDownloadsFile(
        string $sessionId,
        string $remotePath,
        string $destinationPath,
        ?array $access = null,
        ?string $range = null,
        bool $overwrite = false,
    ): array {
        if ($range !== null && preg_match('/^bytes=(?:\d+-\d*|-\d+)$/D', $range) !== 1) {
            throw new InvalidArgumentException('range must use the form bytes=START-END');
        }
        if (!$overwrite && file_exists($destinationPath)) {
            throw new WebBrainApiException("Destination already exists: {$destinationPath}");
        }
        $directory = dirname($destinationPath);
        if (!is_dir($directory) && !mkdir($directory, 0777, true) && !is_dir($directory)) {
            throw new WebBrainApiException("Could not create destination directory: {$directory}");
        }
        $temporaryPath = tempnam($directory, '.' . basename($destinationPath) . '.webbrain-');
        if ($temporaryPath === false) {
            throw new WebBrainApiException('Could not create a temporary download file');
        }
        chmod($temporaryPath, 0600);
        $destination = fopen($temporaryPath, 'wb');
        if ($destination === false) {
            @unlink($temporaryPath);
            throw new WebBrainApiException('Could not open the temporary download file');
        }

        $downloadsAccess = $this->downloadsAccess($sessionId, $access);
        $handle = curl_init($this->downloadsUrl($downloadsAccess, $remotePath));
        $responseHeaders = [];
        $headers = ['Authorization: Basic ' . base64_encode($downloadsAccess['username'] . ':' . $downloadsAccess['password'])];
        if ($range !== null) {
            $headers[] = 'Range: ' . $range;
        }
        curl_setopt_array($handle, [
            CURLOPT_CUSTOMREQUEST => 'GET',
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_FILE => $destination,
            CURLOPT_CONNECTTIMEOUT => $this->timeoutSeconds,
            CURLOPT_TIMEOUT => 0,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$responseHeaders): int {
                $separator = strpos($line, ':');
                if ($separator !== false) {
                    $name = strtolower(trim(substr($line, 0, $separator)));
                    $responseHeaders[$name] = trim(substr($line, $separator + 1));
                }
                return strlen($line);
            },
        ]);
        try {
            $result = curl_exec($handle);
            $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
            $contentType = curl_getinfo($handle, CURLINFO_CONTENT_TYPE) ?: null;
            if ($result === false) {
                throw new WebBrainApiException(curl_error($handle));
            }
        } finally {
            curl_close($handle);
            fclose($destination);
        }

        try {
            if ($status < 200 || $status >= 300) {
                $raw = file_get_contents($temporaryPath, false, null, 0, 1024 * 1024);
                $body = self::decodeDownloadsBody($raw === false ? '' : $raw);
                $message = is_array($body) && isset($body['error'])
                    ? (string) $body['error']
                    : "Downloads request failed with status {$status}";
                throw new WebBrainApiException($message, $status, $body);
            }
            if ($range !== null && $status !== 206) {
                throw new WebBrainApiException('Downloads service did not honor the requested byte range', $status);
            }
            if ($overwrite) {
                if (!rename($temporaryPath, $destinationPath)) {
                    throw new WebBrainApiException("Could not move the download to {$destinationPath}");
                }
            } elseif (!link($temporaryPath, $destinationPath)) {
                throw new WebBrainApiException("Destination already exists or cannot be created: {$destinationPath}");
            } else {
                unlink($temporaryPath);
            }
            $temporaryPath = '';
        } finally {
            if ($temporaryPath !== '') {
                @unlink($temporaryPath);
            }
        }

        return [
            'path' => $destinationPath,
            'size' => filesize($destinationPath),
            'status' => $status,
            'content_type' => $contentType,
            'content_range' => $responseHeaders['content-range'] ?? null,
        ];
    }

    private function downloadsAccess(string $sessionId, ?array $access): array
    {
        $result = $access ?? $this->createDownloadsAccess($sessionId);
        foreach (['url', 'username', 'password'] as $key) {
            if (!isset($result[$key]) || !is_string($result[$key]) || $result[$key] === '') {
                throw new InvalidArgumentException('access must contain url, username, and password');
            }
        }
        self::downloadsBaseUrl($result['url']);
        return $result;
    }

    private function downloadsUrl(array $access, string $remotePath = '', bool $directory = false): string
    {
        $segments = self::downloadsPathSegments($remotePath);
        $encodedPath = implode('/', array_map('rawurlencode', $segments));
        $url = self::downloadsBaseUrl($access['url']) . $encodedPath;
        if ($directory && $encodedPath !== '') {
            $url .= '/';
        }
        return $url;
    }

    private static function downloadsBaseUrl(string $value): string
    {
        $parts = parse_url($value);
        if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
            throw new InvalidArgumentException('Downloads access URL is invalid');
        }
        $scheme = strtolower((string) $parts['scheme']);
        $host = strtolower((string) $parts['host']);
        $loopback = in_array($host, ['localhost', '127.0.0.1', '::1'], true);
        if ($scheme !== 'https' && !($scheme === 'http' && $loopback)) {
            throw new InvalidArgumentException('Downloads access URL must use HTTPS');
        }
        foreach (['user', 'pass', 'query', 'fragment'] as $forbidden) {
            if (array_key_exists($forbidden, $parts)) {
                throw new InvalidArgumentException('Downloads access URL cannot contain credentials, a query, or a fragment');
            }
        }
        return rtrim($value, '/') . '/';
    }

    private static function downloadsPathSegments(string $remotePath): array
    {
        if ($remotePath === '') {
            return [];
        }
        $segments = explode('/', $remotePath);
        foreach ($segments as $segment) {
            if (
                $segment === ''
                || $segment === '.'
                || $segment === '..'
                || str_starts_with($segment, '.')
                || str_contains($segment, '\\')
                || preg_match('/[\x00-\x1f\x7f]/', $segment) === 1
            ) {
                throw new InvalidArgumentException('Downloads paths cannot contain empty, dotfile, traversal, or control-character segments');
            }
        }
        return $segments;
    }

    private function downloadsRequest(
        array $access,
        string $url,
        string $method = 'GET',
        mixed $input = null,
        ?int $inputSize = null,
        array $headers = [],
    ): array {
        $handle = curl_init($url);
        $headers[] = 'Authorization: Basic ' . base64_encode($access['username'] . ':' . $access['password']);
        $options = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => $this->timeoutSeconds,
            CURLOPT_TIMEOUT => 0,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_HEADER => false,
        ];
        if (is_resource($input)) {
            $options[CURLOPT_UPLOAD] = true;
            $options[CURLOPT_INFILE] = $input;
            $options[CURLOPT_INFILESIZE] = $inputSize;
        }
        curl_setopt_array($handle, $options);
        $raw = curl_exec($handle);
        if ($raw === false) {
            $message = curl_error($handle);
            curl_close($handle);
            throw new WebBrainApiException($message);
        }
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);
        $decoded = self::decodeDownloadsBody($raw);
        if ($status < 200 || $status >= 300) {
            $message = is_array($decoded) && isset($decoded['error'])
                ? (string) $decoded['error']
                : "Downloads request failed with status {$status}";
            throw new WebBrainApiException($message, $status, $decoded);
        }
        if (!is_array($decoded)) {
            throw new WebBrainApiException('Downloads service returned an invalid JSON response', $status, $decoded);
        }
        return $decoded;
    }

    private static function decodeDownloadsBody(string $raw): mixed
    {
        if ($raw === '') {
            return null;
        }
        try {
            return json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            return $raw;
        }
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

    public function createWorkflow(string $name, string $sourceSessionId, string $sourceRunId): array
    {
        if ($name === '' || $sourceSessionId === '' || $sourceRunId === '') {
            throw new InvalidArgumentException('name, sourceSessionId, and sourceRunId are required');
        }
        return $this->request('POST', '/api/workflows', [
            'name' => $name,
            'source_session_id' => $sourceSessionId,
            'source_run_id' => $sourceRunId,
        ]);
    }

    public function listWorkflows(int $limit = 50, int $offset = 0): array
    {
        return $this->request('GET', '/api/workflows?limit=' . $limit . '&offset=' . $offset);
    }

    public function getWorkflow(string $workflowId): array
    {
        return $this->request('GET', '/api/workflows/' . self::id($workflowId))['workflow'];
    }

    public function renameWorkflow(string $workflowId, string $name): array
    {
        if ($name === '') {
            throw new InvalidArgumentException('name is required');
        }
        return $this->request(
            'PATCH',
            '/api/workflows/' . self::id($workflowId),
            ['name' => $name],
        )['workflow'];
    }

    public function deleteWorkflow(string $workflowId): void
    {
        $this->request('DELETE', '/api/workflows/' . self::id($workflowId));
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

    public function createWorkflowRun(
        string $sessionId,
        string $workflowId,
        array $parameters = [],
        array $options = [],
    ): array {
        if ($workflowId === '') {
            throw new InvalidArgumentException('workflowId is required');
        }
        $body = [
            'workflow_id' => $workflowId,
            'parameters' => $parameters,
            'wait' => $options['wait'] ?? false,
        ];
        foreach (['timeout_ms', 'tab_id', 'capture'] as $key) {
            if (array_key_exists($key, $options)) {
                $body[$key] = $options[$key];
            }
        }
        return $this->request('POST', '/api/browser-sessions/' . self::id($sessionId) . '/runs', $body);
    }

    public function continueRun(string $sessionId, string $runId, string $task, array $options = []): array
    {
        if ($task === '') {
            throw new InvalidArgumentException('task is required');
        }
        $body = ['task' => $task, 'wait' => $options['wait'] ?? false];
        foreach (['timeout_ms', 'output_schema'] as $key) {
            if (array_key_exists($key, $options)) {
                $body[$key] = $options[$key];
            }
        }
        return $this->request(
            'POST',
            '/api/browser-sessions/' . self::id($sessionId) . '/runs/' . self::id($runId) . '/messages',
            $body,
        );
    }

    public function abortRun(string $sessionId, string $runId): array
    {
        return $this->request('POST', '/api/browser-sessions/' . self::id($sessionId) . '/runs/' . self::id($runId) . '/abort', []);
    }

    public function respondToRun(string $sessionId, string $runId, string $clarifyId, string $answer): array
    {
        if ($clarifyId === '') {
            throw new InvalidArgumentException('clarifyId is required');
        }
        if (trim($answer) === '') {
            throw new InvalidArgumentException('answer is required');
        }
        return $this->request(
            'POST',
            '/api/browser-sessions/' . self::id($sessionId) . '/runs/' . self::id($runId) . '/responses',
            ['clarify_id' => $clarifyId, 'answer' => $answer],
        );
    }

    public function waitForRun(string $sessionId, string $runId, float $pollInterval = 1.0, float $timeout = 120.0): array
    {
        $deadline = microtime(true) + $timeout;
        do {
            $run = $this->getRun($sessionId, $runId);
            if (in_array($run['status'] ?? '', ['completed', 'failed', 'aborted', 'needs_user_input'], true)) {
                return $run;
            }
            if (microtime(true) >= $deadline) {
                throw new WebBrainApiException("Run {$runId} did not finish within {$timeout} seconds", body: $run);
            }
            usleep((int) ($pollInterval * 1_000_000));
        } while (true);
    }
}
