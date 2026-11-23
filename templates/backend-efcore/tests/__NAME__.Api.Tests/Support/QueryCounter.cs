using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace __NAME__.Api.Tests.Support;

/// <summary>
/// Counts every SQL command EF Core sends. It is how an N+1 is proven rather than suspected:
/// call an endpoint with a few rows, then with many, and the count must not change.
/// <code>
/// var few  = await factory.Queries.CountAsync(() => client.GetAsync(url));
/// // ...add twenty more rows...
/// var many = await factory.Queries.CountAsync(() => client.GetAsync(url));
/// Assert.Equal(few, many);
/// </code>
/// </summary>
public sealed class QueryCounter : DbCommandInterceptor
{
    private int count;

    /// <summary>Runs the action and returns how many SQL commands it caused.</summary>
    public async Task<int> CountAsync(Func<Task> action)
    {
        Interlocked.Exchange(ref count, 0);
        await action();
        return Volatile.Read(ref count);
    }

    public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result)
    {
        Interlocked.Increment(ref count);
        return base.ReaderExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
    {
        Interlocked.Increment(ref count);
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }

    public override InterceptionResult<int> NonQueryExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<int> result)
    {
        Interlocked.Increment(ref count);
        return base.NonQueryExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        Interlocked.Increment(ref count);
        return base.NonQueryExecutingAsync(command, eventData, result, cancellationToken);
    }

    public override InterceptionResult<object> ScalarExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<object> result)
    {
        Interlocked.Increment(ref count);
        return base.ScalarExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<object> result, CancellationToken cancellationToken = default)
    {
        Interlocked.Increment(ref count);
        return base.ScalarExecutingAsync(command, eventData, result, cancellationToken);
    }
}
